"""Adapter-driven spawn recognition; this module never executes catch commands."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Iterable

from .models.spawn import SpawnEvent
from .targets.base import BaseTargetAdapter

logger = logging.getLogger(__name__)


class SpawnDetector:
    def __init__(self, adapters: Iterable[BaseTargetAdapter]) -> None:
        self.adapters = tuple(adapters)

    async def detect(self, event: Any) -> SpawnEvent | None:
        message = getattr(event, "message", event)
        message_id = getattr(event, "id", None)
        if message_id is None:
            message_id = getattr(message, "id", None)
        if not isinstance(message_id, int):
            return None
        timestamp = getattr(event, "date", None)
        if not isinstance(timestamp, datetime):
            timestamp = None
        for adapter in self.adapters:
            try:
                if not adapter.is_spawn_message(event):
                    continue
                metadata = await adapter.extract_metadata(event)
            except Exception:
                # Isolate target-specific failures; never log message/media payloads.
                logger.warning("Spawn adapter failed: %s", getattr(adapter, "target_name", type(adapter).__name__))
                continue
            character_name = metadata.character_name
            confidence = metadata.character_confidence if character_name else 0.0
            if not isinstance(confidence, (int, float)) or not 0.0 <= confidence <= 1.0:
                confidence = 0.0
            target_name = getattr(adapter, "target_name", type(adapter).__name__)
            chat_id = getattr(event, "chat_id", None)
            if chat_id is None:
                chat_id = getattr(message, "chat_id", None)
            media_kind = self._media_kind(message)
            spawn_context = None
            if (
                isinstance(target_name, str) and target_name
                and isinstance(chat_id, int) and not isinstance(chat_id, bool)
                and isinstance(media_kind, str)
            ):
                try:
                    from .models.spawn import SpawnContext
                    spawn_context = SpawnContext(
                        source=target_name,
                        chat_id=chat_id,
                        message_id=message_id,
                        media_kind=media_kind,
                    )
                except ValueError:
                    spawn_context = None
            return SpawnEvent(
                message_id=message_id, character_name=character_name,
                confidence_score=float(confidence), metadata=metadata,
                target_name=target_name, timestamp=timestamp,
                spawn_context=spawn_context,
            )
        return None

    @staticmethod
    def _media_kind(message: Any) -> str | None:
        if getattr(message, "photo", None) is not None:
            return "image"
        document = getattr(message, "document", None)
        media = getattr(message, "media", None)
        if document is None and media is not None:
            document = getattr(media, "document", None)
            media_name = type(media).__name__.lower()
            if "photo" in media_name:
                return "photo"
        if document is None:
            return None
        attributes = getattr(document, "attributes", ()) or ()
        names = {type(attribute).__name__.lower() for attribute in attributes}
        if any("video" in name for name in names):
            return "video"
        if any("animated" in name for name in names):
            return "animation"
        if any("audio" in name for name in names):
            return "audio"
        return "document"
        return None
