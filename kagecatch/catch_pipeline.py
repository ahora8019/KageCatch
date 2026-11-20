"""Guarded bridge from normalized Spawn events to CatchEngine.

The pipeline only dispatches when a target recognizer supplied an explicit
character identity with calibrated character confidence, the CatchEngine is
enabled with atomic admission, a per-user opt-in is present, and an adapter can
be created for the authorized user's Telethon client. Otherwise it falls back
to the existing human-review pipeline.
"""
from __future__ import annotations

import inspect
import math
import re
from collections.abc import Callable
from typing import Any

from .engine import Candidate, Spawn


_USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_CONTROL_RANGES = tuple(range(0, 32)) + tuple(range(127, 160))


class CatchPipeline:
    """Compose SpawnDetector, CatchEngine, target adapter, and manual review."""

    def __init__(
        self,
        *,
        detector,
        catch_engine,
        adapter_factory: Callable[[str, Any, Any], Any],
        catch_is_enabled: Callable[[str], Any],
        review_pipeline,
    ) -> None:
        if not callable(adapter_factory):
            raise ValueError("adapter_factory must be callable")
        if not callable(catch_is_enabled):
            raise ValueError("catch_is_enabled must be callable")
        if not callable(getattr(detector, "detect", None)):
            raise ValueError("detector must expose async detect(event)")
        if not callable(getattr(review_pipeline, "process_spawn", None)):
            raise ValueError("review_pipeline must expose process_spawn(spawn, user_id)")
        if not callable(getattr(catch_engine, "handle_spawn", None)):
            raise ValueError("catch_engine must expose handle_spawn(user_id, spawn, adapter)")

        self.detector = detector
        self.catch_engine = catch_engine
        self.adapter_factory = adapter_factory
        self.catch_is_enabled = catch_is_enabled
        self.review_pipeline = review_pipeline

    async def process(self, *, event: Any, user_id: str) -> dict[str, Any]:
        if not isinstance(user_id, str) or not _USER_ID_RE.fullmatch(user_id):
            raise ValueError("user_id must be a canonical identifier")

        detected = await self.detector.detect(event)
        if detected is None:
            return {"status": "no_spawn"}

        if not self._has_trusted_character_identity(detected):
            return await self._manual_review(detected, user_id, event)

        # The recognizer's metadata must belong to the same target that emitted
        # the spawn; otherwise fail closed rather than route a mismatched identity.
        metadata_source = getattr(getattr(detected, "metadata", None), "source", None)
        if not isinstance(detected.target_name, str) or metadata_source != detected.target_name:
            return await self._manual_review(detected, user_id, event)

        if getattr(self.catch_engine, "enabled", False) is not True:
            return await self._manual_review(detected, user_id, event)

        try:
            enabled = self.catch_is_enabled(user_id)
            if inspect.isawaitable(enabled):
                enabled = await enabled
        except Exception:
            enabled = False
        if enabled is not True:
            return await self._manual_review(detected, user_id, event)

        chat_id = self._get_chat_id(event)
        if isinstance(chat_id, bool) or not isinstance(chat_id, int) or chat_id == 0:
            return await self._manual_review(detected, user_id, event)

        try:
            adapter = self.adapter_factory(user_id, event, detected)
            if inspect.isawaitable(adapter):
                adapter = await adapter
        except Exception:
            return await self._manual_review(detected, user_id, event)

        source = detected.target_name
        media_kind = getattr(adapter, "media_kind", None)
        if (
            not isinstance(source, str)
            or not isinstance(media_kind, str)
            or getattr(adapter, "source", None) != source
        ):
            return await self._manual_review(detected, user_id, event)

        metadata = detected.metadata
        candidate = Candidate(
            name=metadata.character_name.strip(),
            confidence=float(metadata.character_confidence),
        )
        if candidate.confidence < self.catch_engine.confidence_threshold:
            return await self._manual_review(detected, user_id, event)

        catch_spawn = Spawn(
            source=source,
            chat_id=chat_id,
            message_id=detected.message_id,
            media_kind=media_kind,
            candidates=(candidate,),
        )
        result = await self.catch_engine.handle_spawn(user_id, catch_spawn, adapter)
        response = {
            "status": result.status,
            "spawn_id": detected.message_id,
        }
        if result.character_name is not None:
            response["character_name"] = result.character_name
        if result.confidence is not None:
            response["confidence"] = result.confidence
        if result.receipt_reference is not None:
            response["receipt_reference"] = result.receipt_reference
        return response

    async def _manual_review(self, detected, user_id: str, event: Any) -> dict[str, Any]:
        return await self.review_pipeline.process_spawn(
            spawn=detected,
            user_id=user_id,
            event=event,
        )

    @staticmethod
    def _get_chat_id(event: Any) -> int | None:
        chat_id = getattr(event, "chat_id", None)
        if chat_id is None:
            message = getattr(event, "message", None)
            chat_id = getattr(message, "chat_id", None)
        return chat_id

    @staticmethod
    def _has_trusted_character_identity(detected: Any) -> bool:
        metadata = getattr(detected, "metadata", None)
        name = getattr(metadata, "character_name", None)
        confidence = getattr(metadata, "character_confidence", None)
        if (
            not isinstance(name, str)
            or not name.strip()
            or len(name.strip()) > 100
            or any(ord(char) in _CONTROL_RANGES for char in name)
            or isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
        ):
            return False
        try:
            value = float(confidence)
        except (TypeError, ValueError, OverflowError):
            return False
        return math.isfinite(value) and 0.0 <= value <= 1.0

