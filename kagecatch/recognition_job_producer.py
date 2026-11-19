"""Convert authorized-session spawn events into idempotent recognition jobs.

This producer performs target detection/metadata extraction only. It never sends
Telegram messages or catch commands; durable review creation is delegated to
RecognitionWorker.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)
JOB_TYPE = "spawn.recognize"


class RecognitionJobProducer:
    def __init__(self, *, detector, queue) -> None:
        self.detector = detector
        self.queue = queue

    async def process(self, user_id: str, event: Any) -> dict[str, Any]:
        if not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 128:
            raise ValueError("valid user_id is required")

        try:
            spawn = await self.detector.detect(event)
            if spawn is None:
                return {"status": "no_spawn"}

            metadata = spawn.metadata
            anime_name = getattr(metadata, "anime_name", None)
            if not isinstance(anime_name, str) or not anime_name.strip():
                return {"status": "no_anime_match", "spawn_id": spawn.message_id}

            message = getattr(event, "message", event)
            chat_id = getattr(event, "chat_id", None)
            if isinstance(chat_id, bool) or not isinstance(chat_id, int):
                chat_id = getattr(message, "chat_id", None)
            message_id = getattr(spawn, "message_id", None)
            if (
                isinstance(chat_id, bool) or not isinstance(chat_id, int)
                or isinstance(message_id, bool) or not isinstance(message_id, int)
                or message_id <= 0
            ):
                return {"status": "invalid_origin"}

            target_name = getattr(spawn, "target_name", None)
            if not isinstance(target_name, str) or not target_name.strip():
                target_name = "unknown"

            payload = {
                "schema_version": 1,
                "user_id": user_id,
                "origin": {
                    "source": target_name[:80],
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "media_kind": "video",
                },
                "recognition": {
                    "anime_name": anime_name.strip()[:256],
                    "anime_confidence": self._confidence(
                        getattr(metadata, "anime_confidence", None)
                    ),
                    "recognition_source": str(
                        getattr(metadata, "source", "unknown") or "unknown"
                    )[:80],
                },
            }
            job = await self.queue.enqueue(
                JOB_TYPE,
                payload,
                idempotency_key=f"spawn:{user_id}:{chat_id}:{message_id}",
            )
            return {"status": "queued", "job_id": job.job_id}
        except Exception:
            # Do not log event objects, media, metadata payloads, or credentials.
            logger.exception("Recognition job production failed for user=%s", user_id)
            return {"status": "enqueue_failed"}

    @staticmethod
    def _confidence(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not 0.0 <= value <= 1.0:
            return None
        return float(value)
