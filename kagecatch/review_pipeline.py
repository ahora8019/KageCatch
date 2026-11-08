"""Spawn-to-manual-review orchestration without Telegram side effects."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ReviewPipelineResult:
    status: str
    spawn_id: int | None = None
    review_item: Any | None = None


class ReviewPipeline:
    """Connect spawn detection, conservative resolution, and durable review.

    This pipeline only creates human-review records. It never sends Telegram
    messages, invokes CatchEngine, or issues commands to target bots.
    """

    def __init__(self, *, detector, resolver, review_queue) -> None:
        self.detector = detector
        self.resolver = resolver
        self.review_queue = review_queue

    async def process(self, *, event: Any, user_id: str) -> ReviewPipelineResult:
        if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")

        spawn = await self.detector.detect(event)
        if spawn is None:
            return ReviewPipelineResult(status="no_spawn")

        metadata = spawn.metadata
        anime_name = getattr(metadata, "anime_name", None)
        if not isinstance(anime_name, str) or not anime_name.strip():
            return ReviewPipelineResult(status="no_candidates", spawn_id=spawn.message_id)

        resolved = await self.resolver.resolve(metadata)
        if resolved is None or not getattr(resolved, "candidates", ()):
            return ReviewPipelineResult(status="no_candidates", spawn_id=spawn.message_id)

        try:
            item = await self.review_queue.enqueue(
                user_id=user_id,
                spawn_id=spawn.message_id,
                anime_name=anime_name,
                candidates=resolved.candidates,
            )
        except Exception:
            # A failed durable write is never represented as a successful enqueue.
            # Keep the log free of event payloads, sessions, and credentials.
            logger.exception(
                "Manual review persistence failed for user_id=%s spawn_id=%s",
                spawn.message_id,
            )
            return ReviewPipelineResult(
                status="review_persistence_failed", spawn_id=spawn.message_id,
            )

        return ReviewPipelineResult(
            status="review_queued", spawn_id=spawn.message_id, review_item=item,
        )
