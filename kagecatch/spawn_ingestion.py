"""Connect normalized SpawnDetector events to the persistent recognition queue.

This boundary stores metadata only. It does not download media, recognize images,
or issue commands to Telegram target bots.
"""
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
        self, job_type: str, payload: dict[str, Any], *,
        priority: int = 0, idempotency_key: str | None = None,
        max_attempts: int = 3,
    ) -> Job: ...


@dataclass(frozen=True, slots=True)
class IngestionResult:
    status: str
    job_id: str | None = None


class SpawnIngestionPipeline:
    """Detect events and persist safe, normalized recognition jobs."""

    def __init__(
        self,
        detector: Detector,
        queue: JobQueue,
        *,
        priority: int = 10,
        max_attempts: int = 4,
    ) -> None:
        if isinstance(priority, bool) or not isinstance(priority, int):
            raise ValueError("priority must be an integer")
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or not 1 <= max_attempts <= 20:
            raise ValueError("max_attempts must be between 1 and 20")
        self.detector = detector
        self.queue = queue
        self.priority = priority
        self.max_attempts = max_attempts

    async def ingest(self, event: Any) -> IngestionResult:
        detected = await self.detector.detect(event)
        if detected is None:
            return IngestionResult("ignored")
        context = detected.spawn_context
        if context is None:
            return IngestionResult("invalid_origin")

        timestamp = detected.timestamp
        if isinstance(timestamp, datetime):
            timestamp_value = timestamp.isoformat()
        else:
            timestamp_value = None

        payload = {
            "schema_version": 1,
            "origin": {
                "source": context.source,
                "chat_id": context.chat_id,
                "message_id": context.message_id,
                "media_kind": context.media_kind,
                "timestamp": timestamp_value,
            },
            "recognition": {
                "character_name": detected.character_name,
                "confidence": self._safe_confidence(detected.confidence_score),
                "anime_name": detected.metadata.anime_name,
                "character_confidence": self._safe_confidence(
                    detected.metadata.character_confidence
                ),
                "anime_confidence": self._optional_confidence(
                    detected.metadata.anime_confidence
                ),
                "recognition_source": detected.metadata.source,
            },
            "target": {"name": detected.target_name},
        }
        idempotency_key = (
            f"spawn:{context.source}:{context.chat_id}:{context.message_id}"
        )
        job = await self.queue.enqueue(
            "spawn.recognize",
            payload,
            priority=self.priority,
            idempotency_key=idempotency_key,
            max_attempts=self.max_attempts,
        )
        return IngestionResult("queued", job.job_id)

    @staticmethod
    def _safe_confidence(value: Any) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return 0.0
        if not 0.0 <= value <= 1.0:
            return 0.0
        return float(value)

    @classmethod
    def _optional_confidence(cls, value: Any) -> float | None:
        if value is None:
            return None
        return cls._safe_confidence(value)
