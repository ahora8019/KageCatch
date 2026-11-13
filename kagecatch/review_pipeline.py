"""Spawn-to-manual-review orchestration without Telegram side effects."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .monitoring import emit_monitor_event

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

        try:
            spawn = await self.detector.detect(event)
        except Exception:
            # Telethon update handlers must remain isolated from target-specific
            # recognition failures. Never log event payloads or exception text.
            emit_monitor_event("spawn_detection_failed", level=logging.WARNING)
            logger.warning("Spawn detection failed; incoming update ignored")
            return {"status": "detection_failed"}

        if spawn is None:
            return {"status": "no_spawn"}

        emit_monitor_event("spawn_detected")
        metadata = spawn.metadata
        anime_name = getattr(metadata, "anime_name", None)
        if not isinstance(anime_name, str) or not anime_name.strip():
            emit_monitor_event("spawn_no_candidates", level=logging.INFO)
            return {"status": "no_candidates", "spawn_id": spawn.message_id}

        try:
            resolved = await self.resolver.resolve(metadata)
        except Exception:
            emit_monitor_event("spawn_no_candidates", level=logging.WARNING)
            logger.warning("Character candidate resolution failed")
            return {"status": "no_candidates", "spawn_id": spawn.message_id}

        if resolved is None or not getattr(resolved, "candidates", ()):
            emit_monitor_event("spawn_no_candidates", level=logging.INFO)
            return {"status": "no_candidates", "spawn_id": spawn.message_id}

        try:
            item = await self.review_queue.enqueue(
                user_id=user_id,
                spawn_id=spawn.message_id,
                anime_name=anime_name,
                candidates=resolved.candidates,
            )
        except httpx.TimeoutException:
            emit_monitor_event("review_persistence_failed", level=logging.WARNING)
            logger.warning("Manual review persistence timed out")
            return {
                "status": "review_persistence_failed",
                "error": "D1 unreachable",
            }
        except httpx.TransportError:
            emit_monitor_event("review_persistence_failed", level=logging.WARNING)
            logger.warning("Manual review transport failed")
            return {
                "status": "review_persistence_failed",
                "error": "D1 unreachable",
            }
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            try:
                worker_error = exc.response.json().get("error")
            except (ValueError, AttributeError):
                worker_error = None

            if status_code == 401 and worker_error == "invalid_signature":
                error = "D1 HMAC signature invalid"
            elif status_code == 401:
                error = "D1 authentication failed"
            elif worker_error == "storage_not_configured":
                error = "D1 binding misconfigured"
            elif worker_error == "storage_auth_not_configured":
                error = "Worker HMAC secret missing"
            elif worker_error == "replay_guard_unavailable":
                error = "Worker replay guard unavailable"
            elif status_code >= 500:
                error = "D1 unreachable"
            else:
                error = "D1 request rejected"

            emit_monitor_event("review_persistence_failed", level=logging.WARNING)
            logger.warning(
                "Manual review Worker rejected persistence (HTTP %s, category=%s)",
                status_code,
                error,
            )
            return {
                "status": "review_persistence_failed",
                "error": error,
            }
        except Exception:
            # A failed durable write is never represented as a successful enqueue.
            # Keep logs free of event payloads, sessions, credentials and response bodies.
            emit_monitor_event("review_persistence_failed", level=logging.WARNING)
            logger.warning("Manual review persistence failed")
            return {
                "status": "review_persistence_failed",
                "error": "D1 persistence failed",
            }

        emit_monitor_event("manual_review_queued")
        return {
            "status": "review_queued",
            "spawn_id": spawn.message_id,
            "review_item": item,
        }
