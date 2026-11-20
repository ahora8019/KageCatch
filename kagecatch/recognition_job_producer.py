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
            message = getattr(event, "message", event)
            chat_id = getattr(event, "chat_id", None)
            if isinstance(chat_id, bool) or not isinstance(chat_id, int):
                chat_id = getattr(message, "chat_id", None)
            media_kind = getattr(event, "media_kind", None)
            if not isinstance(media_kind, str):
                media_kind = getattr(message, "media_kind", None)
            return await self.process_spawn(
                user_id=user_id, spawn=spawn, chat_id=chat_id,
                media_kind=media_kind if isinstance(media_kind, str) else "unknown",
            )
        except Exception:
            # Do not log event objects, media, metadata payloads, or credentials.
            logger.exception("Recognition job production failed for user=%s", user_id)
            return {"status": "enqueue_failed"}

    async def process_spawn(
        self, *, user_id: str, spawn: Any, chat_id: int,
        media_kind: str = "unknown",
    ) -> dict[str, Any]:
        """Queue an already-detected spawn; never invokes the detector.

        CatchPipeline can call this only on its manual-review branch, passing
        the validated chat identifier separately. The raw Telegram event is
        deliberately not retained or serialized.
        """
        if not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 128:
            raise ValueError("valid user_id is required")
        if isinstance(chat_id, bool) or not isinstance(chat_id, int) or chat_id == 0:
            return {"status": "invalid_origin"}
        if media_kind not in {"video", "photo", "image", "document", "unknown"}:
            return {"status": "invalid_origin"}

        try:
            if spawn is None:
                return {"status": "no_spawn"}
            metadata = getattr(spawn, "metadata", None)
            anime_name = getattr(metadata, "anime_name", None)
            if not isinstance(anime_name, str) or not anime_name.strip():
                return {"status": "no_anime_match", "spawn_id": getattr(spawn, "message_id", None)}

            message_id = getattr(spawn, "message_id", None)
            if isinstance(message_id, bool) or not isinstance(message_id, int) or message_id <= 0:
                return {"status": "invalid_origin"}

            target_name = getattr(spawn, "target_name", None)
            if not isinstance(target_name, str) or not target_name.strip():
                return {"status": "invalid_origin"}
            target_name = target_name.strip()
            if len(target_name) > 80 or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in target_name):
                return {"status": "invalid_origin"}

            source = getattr(metadata, "source", None)
            if not isinstance(source, str) or not source.strip() or len(source) > 80:
                source = "unknown"
            payload = {
                "schema_version": 1,
                "user_id": user_id,
                "origin": {
                    "source": target_name,
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "media_kind": media_kind,
                },
                "recognition": {
                    "anime_name": anime_name.strip()[:256],
                    "anime_confidence": self._confidence(
                        getattr(metadata, "anime_confidence", None)
                    ),
                    "recognition_source": source.strip()[:80],
                },
            }
            job = await self.queue.enqueue(
                JOB_TYPE,
                payload,
                idempotency_key=f"spawn:{user_id}:{chat_id}:{message_id}",
            )
            return {"status": "queued", "job_id": job.job_id}
        except Exception:
            logger.exception("Recognition job production failed for user=%s", user_id)
            return {"status": "enqueue_failed"}

    @staticmethod
    def _confidence(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not 0.0 <= value <= 1.0:
            return None
        return float(value)
