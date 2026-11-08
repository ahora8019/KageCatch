"""Durable implementation of the ManualReviewQueue state-machine contract."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable, Sequence
from uuid import uuid4

from .manual_review_queue import ManualReviewQueue, ReviewItem, ReviewStatus


class PersistentManualReviewQueue:
    """Manual review queue whose records survive Core process restarts.

    The backing store is responsible for atomic conditional state transitions.
    Cloudflare D1 implements those transitions in the signed Worker endpoint.
    """

    def __init__(
        self,
        *,
        store,
        default_ttl: timedelta = timedelta(minutes=15),
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not isinstance(default_ttl, timedelta) or default_ttl <= timedelta(0):
            raise ValueError("default_ttl must be a positive timedelta")
        self._store = store
        self._default_ttl = default_ttl
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    async def enqueue(
        self, *, user_id: str, spawn_id: int, anime_name: str,
        candidates: Sequence[str],
    ) -> ReviewItem:
        ManualReviewQueue._validate_user_id(user_id)
        if isinstance(spawn_id, bool) or not isinstance(spawn_id, int) or not 0 <= spawn_id <= (2**53 - 1):
            raise ValueError("spawn_id must be a non-negative safe integer")
        if not isinstance(anime_name, str) or not anime_name.strip() or len(anime_name.strip()) > 300:
            raise ValueError("anime_name must contain 1 to 300 characters")
        if isinstance(candidates, (str, bytes)) or not isinstance(candidates, Sequence):
            raise ValueError("candidates must be a non-empty sequence of names")
        names = tuple(
            candidate.strip() for candidate in candidates
            if isinstance(candidate, str) and candidate.strip()
        )
        if not names or len(names) != len(candidates) or len(names) > 30:
            raise ValueError("candidates must contain 1 to 30 non-empty strings")
        if any(len(name) > 100 for name in names):
            raise ValueError("candidate names must not exceed 100 characters")
        now = self._now()
        item = ReviewItem(
            review_id=uuid4().hex, user_id=user_id, spawn_id=spawn_id,
            anime_name=anime_name.strip(), candidates=names,
            created_at=now, expires_at=now + self._default_ttl,
        )
        await self._store.create(self._serialize(item))
        return item

    async def get_pending(self, *, user_id: str) -> list[ReviewItem]:
        ManualReviewQueue._validate_user_id(user_id)
        records = await self._store.list_pending(user_id)
        items = [self._deserialize(record) for record in records]
        return [item for item in items if item.user_id == user_id]

    async def approve(
        self, *, user_id: str, review_id: str, candidate_index: int,
    ) -> ReviewItem:
        ManualReviewQueue._validate_user_id(user_id)
        if isinstance(candidate_index, bool) or not isinstance(candidate_index, int):
            raise ValueError("candidate_index must be an integer")
        record = await self._store.resolve(
            user_id=user_id, review_id=review_id,
            action="approve", candidate_index=candidate_index,
        )
        return self._deserialize(record)

    async def reject(self, *, user_id: str, review_id: str) -> ReviewItem:
        ManualReviewQueue._validate_user_id(user_id)
        record = await self._store.resolve(
            user_id=user_id, review_id=review_id, action="reject",
        )
        return self._deserialize(record)

    async def expire_old_items(self) -> int:
        return await self._store.expire()

    def _now(self) -> datetime:
        now = self._clock()
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("clock must return a timezone-aware datetime")
        return now.astimezone(timezone.utc)

    @staticmethod
    def _serialize(item: ReviewItem) -> dict:
        return {
            "review_id": item.review_id,
            "user_id": item.user_id,
            "spawn_id": item.spawn_id,
            "anime_name": item.anime_name,
            "candidates": list(item.candidates),
            "created_at": item.created_at.isoformat(),
            "expires_at": item.expires_at.isoformat(),
        }

    @staticmethod
    def _deserialize(record: dict) -> ReviewItem:
        try:
            return ReviewItem(
                review_id=record["review_id"],
                user_id=record["user_id"],
                spawn_id=int(record["spawn_id"]),
                anime_name=record["anime_name"],
                candidates=tuple(record["candidates"]),
                created_at=datetime.fromisoformat(record["created_at"]).astimezone(timezone.utc),
                expires_at=datetime.fromisoformat(record["expires_at"]).astimezone(timezone.utc),
                status=ReviewStatus(record["status"]),
                selected_character=record.get("selected_character"),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError("manual review store returned an invalid record") from exc
