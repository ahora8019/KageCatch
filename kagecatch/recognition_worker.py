"""Consume recognition jobs and route uncertain identity to human review."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from .models.spawn import CharacterMetadata, SpawnContext


class Queue(Protocol):
    async def claim_next(self, worker_id: str, *, lease_seconds: float = 60): ...
    async def complete(self, job_id: str, worker_id: str) -> None: ...
    async def fail(self, job_id: str, worker_id: str, *, retry_delay: float = 0) -> str: ...
    async def recover_expired(self) -> int: ...


@dataclass(frozen=True, slots=True)
class RecognitionWorkResult:
    status: str
    job_id: str | None = None
    review_item: Any = None


class RecognitionWorker:
    def __init__(self, *, queue: Queue, resolver, review_queue, worker_id: str,
                 lease_seconds: float = 60, retry_delay: float = 5) -> None:
        if not isinstance(worker_id, str) or not worker_id.strip() or len(worker_id) > 128:
            raise ValueError("worker_id must contain 1 to 128 characters")
        if isinstance(lease_seconds, bool) or not isinstance(lease_seconds, (int, float)) or not 1 <= lease_seconds <= 3600:
            raise ValueError("lease_seconds must be between 1 and 3600")
        if isinstance(retry_delay, bool) or not isinstance(retry_delay, (int, float)) or retry_delay < 0:
            raise ValueError("retry_delay must be non-negative")
        self.queue, self.resolver, self.review_queue = queue, resolver, review_queue
        self.worker_id, self.lease_seconds, self.retry_delay = worker_id, float(lease_seconds), float(retry_delay)

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
                not isinstance(origin, dict) or not isinstance(recognition, dict)
                or not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 128
                or isinstance(origin.get("chat_id"), bool) or not isinstance(origin.get("chat_id"), int)
                or isinstance(origin.get("message_id"), bool) or not isinstance(origin.get("message_id"), int)
                or not isinstance(origin.get("source"), str)
                or not isinstance(origin.get("media_kind"), str)
            ):
                await self.queue.complete(job.job_id, self.worker_id)
                return RecognitionWorkResult("invalid_metadata", job.job_id)
            anime_name = recognition.get("anime_name")
            if not isinstance(anime_name, str) or not anime_name.strip():
                await self.queue.complete(job.job_id, self.worker_id)
                return RecognitionWorkResult("invalid_metadata", job.job_id)
            timestamp = None
            if isinstance(origin.get("timestamp"), str):
                try:
                    timestamp = datetime.fromisoformat(origin["timestamp"])
                except ValueError:
                    pass
            context = SpawnContext(source=origin["source"], chat_id=origin["chat_id"],
                message_id=origin["message_id"], media_kind=origin["media_kind"])
            metadata = CharacterMetadata(anime_name=anime_name.strip(),
                source=str(recognition.get("recognition_source") or "unknown")[:80],
                character_name=None, anime_confidence=self._confidence(recognition.get("anime_confidence")),
                character_confidence=0.0, additional={})
            resolved = await self.resolver.resolve(metadata)
            candidates = getattr(resolved, "candidates", ()) if resolved is not None else ()
            if not candidates:
                await self.queue.complete(job.job_id, self.worker_id)
                return RecognitionWorkResult("no_candidates", job.job_id)
            review_item = await self.review_queue.enqueue(user_id=user_id,
                spawn_id=context.message_id, anime_name=anime_name.strip(),
                candidates=tuple(candidates), spawn_context=context)
            await self.queue.complete(job.job_id, self.worker_id)
            return RecognitionWorkResult("review_queued", job.job_id, review_item)
        except Exception:
            await self.queue.fail(job.job_id, self.worker_id, retry_delay=self.retry_delay)
            return RecognitionWorkResult("retry_scheduled", job.job_id)

    async def run_forever(self, *, stop_event: asyncio.Event, idle_sleep: float = 1.0) -> int:
        """Sequential, memory-bounded polling loop with graceful stop and lease recovery."""
        if not isinstance(stop_event, asyncio.Event):
            raise ValueError("stop_event must be an asyncio.Event")
        if isinstance(idle_sleep, bool) or not isinstance(idle_sleep, (int, float)) or not 0 < idle_sleep <= 60:
            raise ValueError("idle_sleep must be between 0 and 60 seconds")
        processed = 0
        while not stop_event.is_set():
            await self.queue.recover_expired()
            if stop_event.is_set():
                break
            result = await self.run_once()
            if result.status == "review_queued":
                processed += 1
            elif result.status == "idle":
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=float(idle_sleep))
                except asyncio.TimeoutError:
                    pass
        return processed

    @staticmethod
    def _confidence(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0.0 <= value <= 1.0:
            return None
        return float(value)
