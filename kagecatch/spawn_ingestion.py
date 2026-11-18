"""Connect normalized SpawnDetector events to the persistent recognition queue."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from .job_queue import Job
from .models.spawn import SpawnEvent


class Detector(Protocol):
    async def detect(self, event: Any) -> SpawnEvent | None: ...


class JobQueue(Protocol):
    async def enqueue(
        self, job_type: str, payload: dict[str, Any], *, priority: int = 0,
        idempotency_key: str | None = None, max_attempts: int = 3,
    ) -> Job: ...


@dataclass(frozen=True, slots=True)
class IngestionResult:
    status: str
    job_id: str | None = None


class SpawnIngestionPipeline:
    """Detect events and persist safe, normalized recognition jobs."""

    def __init__(
        self, detector: Detector, queue: JobQueue, *,
        priority: int = 10, max_attempts: int = 4,
    ) -> None:
        if isinstance(priority, bool) or not isinstance(priority, int):
            raise ValueError("priority must be an integer")
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or not 1 <= max_attempts <= 20:
            raise ValueError("max_attempts must be between 1 and 20")
        self.detector, self.queue = detector, queue
        self.priority, self.max_attempts = priority, max_attempts

    async def ingest(self, event: Any, *, user_id: str) -> IngestionResult:
        if not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 128:
            raise ValueError("valid user_id is required")
        detected = await self.detector.detect(event)
        if detected is None:
            return IngestionResult("ignored")
        context = detected.spawn_context
        if context is None:
            return IngestionResult("invalid_origin")
        timestamp = detected.timestamp
        timestamp_value = timestamp.isoformat() if isinstance(timestamp, datetime) else None
        payload = {
            "schema_version": 1,
            "user_id": user_id,
            "origin": {
                "source": context.source, "chat_id": context.chat_id,
                "message_id": context.message_id, "media_kind": context.media_kind,
                "timestamp": timestamp_value,
            },
            "recognition": {
                # Hints only; RecognitionWorker deliberately ignores these when
                # resolving identity and asks the resolver for independent candidates.
                "character_name": detected.character_name,
                "confidence": self._safe_confidence(detected.confidence_score),
                "anime_name": detected.metadata.anime_name,
                "character_confidence": self._safe_confidence(
                    detected.metadata.character_confidence
                ),
                "anime_confidence": self._optional_confidence(detected.metadata.anime_confidence),
                "recognition_source": detected.metadata.source,
            },
            "target": {"name": detected.target_name},
        }
        key = f"spawn:{context.source}:{context.chat_id}:{context.message_id}"
        job = await self.queue.enqueue(
            "spawn.recognize", payload, priority=self.priority,
            idempotency_key=key, max_attempts=self.max_attempts,
        )
        return IngestionResult("queued", job.job_id)

    @staticmethod
    def _safe_confidence(value: Any) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0.0 <= value <= 1.0:
            return 0.0
        return float(value)

    @classmethod
    def _optional_confidence(cls, value: Any) -> float | None:
        return None if value is None else cls._safe_confidence(value)
