"""Consume recognition jobs and route uncertain identity to human review.

This worker never chooses a character for automatic catching and has no Telegram
or target-adapter dependency.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from .models.spawn import CharacterMetadata, SpawnContext


class Queue(Protocol):
    async def claim_next(self, worker_id: str, *, lease_seconds: float = 60): ...
    async def complete(self, job_id: str, worker_id: str) -> None: ...
    async def fail(self, job_id: str, worker_id: str, *, retry_delay: float = 0) -> str: ...


@dataclass(frozen=True, slots=True)
class RecognitionWorkResult:
    status: str
    job_id: str | None = None
    review_item: Any = None


class RecognitionWorker:
    def __init__(
        self, *, queue: Queue, resolver, review_queue,
        worker_id: str, lease_seconds: float = 60, retry_delay: float = 5,
    ) -> None:
        if not isinstance(worker_id, str) or not worker_id.strip() or len(worker_id) > 128:
            raise ValueError("worker_id must contain 1 to 128 characters")
        if not 1 <= lease_seconds <= 3600:
            raise ValueError("lease_seconds must be between 1 and 3600")
        if retry_delay < 0:
            raise ValueError("retry_delay must be non-negative")
        self.queue, self.resolver, self.review_queue = queue, resolver, review_queue
        self.worker_id, self.lease_seconds, self.retry_delay = worker_id, lease_seconds, retry_delay

    async def run_once(self) -> RecognitionWorkResult:
        job = await self.queue.claim_next(self.worker_id, lease_seconds=self.lease_seconds)
        if job is None:
            return RecognitionWorkResult("idle")
        try:
            payload = job.payload
            if not isinstance(payload, dict) or payload.get("schema_version") != 1:
                await self.queue.complete(job.job_id, self.worker_id)
                return RecognitionWorkResult("invalid_payload", job.job_id)
            origin, recognition = payload.get("origin"), payload.get("recognition")
            user_id = payload.get("user_id")
            if (
                not isinstance(origin, dict)
                or not isinstance(recognition, dict)
                or not isinstance(user_id, str)
                or not user_id
                or len(user_id) > 128
                or not isinstance(origin.get("chat_id"), int)
                or isinstance(origin.get("chat_id"), bool)
                or not isinstance(origin.get("message_id"), int)
                or isinstance(origin.get("message_id"), bool)
                or not isinstance(origin.get("source"), str)
                or not isinstance(origin.get("media_kind"), str)
            ):
                await self.queue.complete(job.job_id, self.worker_id)
                return RecognitionWorkResult("invalid_metadata", job.job_id)

            anime_name = recognition.get("anime_name")
            if not isinstance(anime_name, str) or not anime_name.strip():
                await self.queue.complete(job.job_id, self.worker_id)
                return RecognitionWorkResult("invalid_metadata", job.job_id)

            timestamp_value = origin.get("timestamp")
            timestamp = None
            if isinstance(timestamp_value, str):
                try:
                    timestamp = datetime.fromisoformat(timestamp_value)
                except ValueError:
                    timestamp = None
            context = SpawnContext(
                source=origin["source"],
                chat_id=origin["chat_id"],
                message_id=origin["message_id"],
                media_kind=origin["media_kind"],
            )
            metadata = CharacterMetadata(
                anime_name=anime_name.strip(),
                source=str(recognition.get("recognition_source") or "unknown")[:80],
                character_name=None,
                anime_confidence=self._confidence(recognition.get("anime_confidence")),
                character_confidence=0.0,
                additional={},
            )
            resolved = await self.resolver.resolve(metadata)
            candidates = getattr(resolved, "candidates", ()) if resolved is not None else ()
            if not candidates:
                await self.queue.complete(job.job_id, self.worker_id)
                return RecognitionWorkResult("no_candidates", job.job_id)

            # Candidate lists are suggestions only. Never promote the incoming
            # character_name/confidence fields to a verified identity.
            review_item = await self.review_queue.enqueue(
                user_id=user_id,
                spawn_id=context.message_id,
                anime_name=anime_name.strip(),
                candidates=tuple(candidates),
                spawn_context=context,
            )
            await self.queue.complete(job.job_id, self.worker_id)
            return RecognitionWorkResult("review_queued", job.job_id, review_item)
        except Exception:
            # Do not log exception text or payloads; retry through the durable queue.
            await self.queue.fail(job.job_id, self.worker_id, retry_delay=self.retry_delay)
            return RecognitionWorkResult("retry_scheduled", job.job_id)

    @staticmethod
    def _confidence(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not 0.0 <= value <= 1.0:
            return None
        return float(value)
