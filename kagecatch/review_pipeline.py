"""Spawn-to-manual-review orchestration without Telegram side effects."""

from __future__ import annotations

import logging
import math
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
        return await self.process_spawn(spawn=spawn, user_id=user_id)

    async def process_spawn(self, *, spawn, user_id: str) -> dict[str, Any]:
        """Persist an already-detected spawn without re-running media recognition."""
        if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")
        if spawn is None:
            return {"status": "no_spawn"}

        metadata = spawn.metadata
        anime_name = getattr(metadata, "anime_name", None)
        if not isinstance(anime_name, str) or not anime_name.strip():
            anime_name = None

        additional = getattr(metadata, "additional", None)
        recognition_status = (
            additional.get("character_recognition_status")
            if isinstance(additional, dict) else None
        )
        character_name = getattr(metadata, "character_name", None)
        confidence = getattr(metadata, "character_confidence", None)
        metadata_source = getattr(metadata, "source", None)
        target_name = getattr(spawn, "target_name", None)
        catalog_verified = (
            recognition_status == "known"
            and metadata_source == target_name
            and isinstance(character_name, str)
            and bool(character_name.strip())
            and len(character_name.strip()) <= 100
            and not any(ord(char) < 32 or 127 <= ord(char) < 160 for char in character_name)
            and not isinstance(confidence, bool)
            and isinstance(confidence, (int, float))
            and math.isfinite(float(confidence))
            and 0.0 <= float(confidence) <= 1.0
        )

        if catalog_verified:
            anime_name = anime_name or "Unknown anime"
            candidates = (character_name.strip(),)
        else:
            if anime_name is None:
                return {"status": "no_candidates", "spawn_id": spawn.message_id}
            resolved = await self.resolver.resolve(metadata)
            if resolved is None or not getattr(resolved, "candidates", ()):
                return {"status": "no_candidates", "spawn_id": spawn.message_id}
            candidates = resolved.candidates

        try:
            item = await self.review_queue.enqueue(
                user_id=user_id,
                spawn_id=spawn.message_id,
                anime_name=anime_name,
                candidates=candidates,
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

            logger.error(
                "Manual review Worker returned HTTP %s error=%s (spawn_id=%s)",
                status_code,
                worker_error or "unspecified",
                spawn.message_id,
            )
            return {
                "status": "review_persistence_failed",
                "error": error,
            }
        except Exception:
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
