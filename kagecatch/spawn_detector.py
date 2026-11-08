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
            return SpawnEvent(
                message_id=message_id, character_name=character_name,
                confidence_score=float(confidence), metadata=metadata,
                target_name=getattr(adapter, "target_name", type(adapter).__name__),
                timestamp=timestamp,
            )
        return None
