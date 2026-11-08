"""Spawn-to-manual-review orchestration without Telegram side effects."""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class ReviewPipeline:
    """Connect spawn detection, conservative resolution, and durable review.

    This pipeline only creates human-review records. It never sends Telegram
    messages, invokes CatchEngine, or issues commands to target bots.

    Results are plain dictionaries so callers cannot accidentally mistake a
    failed persistence operation for a durable ReviewItem.
    """

    def __init__(self, *, detector, resolver, review_queue) -> None:
        self.detector = detector
        self.resolver = resolver
        self.review_queue = review_queue

    async def process(self, *, event: Any, user_id: str) -> dict[str, Any]:
        if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")

        spawn = await self.detector.detect(event)
        if spawn is None:
            return {"status": "no_spawn"}

        metadata = spawn.metadata
        anime_name = getattr(metadata, "anime_name", None)
        if not isinstance(anime_name, str) or not anime_name.strip():
            return {"status": "no_candidates", "spawn_id": spawn.message_id}

        resolved = await self.resolver.resolve(metadata)
        if resolved is None or not getattr(resolved, "candidates", ()):
            return {"status": "no_candidates", "spawn_id": spawn.message_id}

        try:
            item = await self.review_queue.enqueue(
                user_id=user_id,
                spawn_id=spawn.message_id,
                anime_name=anime_name,
                candidates=resolved.candidates,
            )
        except httpx.TimeoutException:
            logger.exception(
                "Manual review persistence timed out (spawn_id=%s)",
                spawn.message_id,
            )
            return {
                "status": "review_persistence_failed",
                "error": "D1 unreachable",
            }
        except httpx.TransportError:
            logger.exception(
                "Manual review transport failed (spawn_id=%s)",
                spawn.message_id,
            )
            return {
                "status": "review_persistence_failed",
                "error": "D1 unreachable",
            }
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            if status_code == 401:
                error = "D1 authentication failed"
            elif status_code >= 500:
                error = "D1 unreachable"
            else:
                error = "D1 request rejected"
            logger.error(
                "Manual review Worker returned HTTP %s (spawn_id=%s)",
                status_code,
                spawn.message_id,
            )
            return {
                "status": "review_persistence_failed",
                "error": error,
            }
        except Exception:
            # A failed durable write is never represented as a successful enqueue.
            # Keep the log free of event payloads, sessions, credentials and response bodies.
            logger.exception(
                "Manual review persistence failed (spawn_id=%s)",
                spawn.message_id,
            )
            return {
                "status": "review_persistence_failed",
                "error": "D1 persistence failed",
            }

        return {
            "status": "review_queued",
            "spawn_id": spawn.message_id,
            "review_item": item,
        }
