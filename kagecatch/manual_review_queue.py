"""In-memory, per-user queue for human review of character suggestions.

This module deliberately has no Telegram, persistence, or Catch execution
integration. It provides a small async interface that can later be backed by a
durable store without changing the review state machine.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Callable, Sequence
from uuid import uuid4


class ReviewStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"


@dataclass(frozen=True, slots=True)
class ReviewItem:
    """Immutable review request scoped to one KageCatch user."""

    review_id: str
    user_id: str
    spawn_id: int
    anime_name: str
    candidates: tuple[str, ...]
    created_at: datetime
    expires_at: datetime
    status: ReviewStatus = ReviewStatus.PENDING
    selected_character: str | None = None


class ManualReviewQueue:
    """Concurrency-safe in-memory review queue.

    Items are isolated by user ID. A caller must supply the owning user ID for
    every read or state transition. Unknown and other users' review IDs are
    intentionally indistinguishable.
    """

    def __init__(
        self,
        *,
        default_ttl: timedelta = timedelta(minutes=15),
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not isinstance(default_ttl, timedelta) or default_ttl <= timedelta(0):
            raise ValueError("default_ttl must be a positive timedelta")
        self._default_ttl = default_ttl
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._items: dict[str, ReviewItem] = {}
        self._lock = asyncio.Lock()

    async def enqueue(
        self,
        *,
        user_id: str,
        spawn_id: int,
        anime_name: str,
        candidates: Sequence[str],
    ) -> ReviewItem:
        self._validate_user_id(user_id)
        if isinstance(spawn_id, bool) or not isinstance(spawn_id, int) or spawn_id < 0:
            raise ValueError("spawn_id must be a non-negative integer")
        if not isinstance(anime_name, str) or not anime_name.strip():
            raise ValueError("anime_name is required")
        if isinstance(candidates, (str, bytes)) or not isinstance(candidates, Sequence):
            raise ValueError("candidates must be a non-empty sequence of names")

        normalized_candidates = tuple(
            candidate.strip()
            for candidate in candidates
            if isinstance(candidate, str) and candidate.strip()
        )
        if not normalized_candidates or len(normalized_candidates) != len(candidates):
            raise ValueError("candidates must contain non-empty strings")

        now = self._now()
        item = ReviewItem(
            review_id=uuid4().hex,
            user_id=user_id,
            spawn_id=spawn_id,
            anime_name=anime_name.strip(),
            candidates=normalized_candidates,
            created_at=now,
            expires_at=now + self._default_ttl,
        )
        async with self._lock:
            self._items[item.review_id] = item
        return item

    async def get_pending(self, *, user_id: str) -> list[ReviewItem]:
        self._validate_user_id(user_id)
        async with self._lock:
            self._expire_due_items(self._now())
            return [
                item
                for item in self._items.values()
                if item.user_id == user_id and item.status is ReviewStatus.PENDING
            ]

    async def approve(
        self,
        *,
        user_id: str,
        review_id: str,
        candidate_index: int,
    ) -> ReviewItem:
        self._validate_user_id(user_id)
        if isinstance(candidate_index, bool) or not isinstance(candidate_index, int):
            raise ValueError("candidate_index must be an integer")
        async with self._lock:
            item = self._get_owned_item(user_id, review_id)
            now = self._now()
            if item.status is ReviewStatus.PENDING and now >= item.expires_at:
                item = replace(item, status=ReviewStatus.EXPIRED)
                self._items[review_id] = item
                return item
            self._require_pending(item)
            if not 0 <= candidate_index < len(item.candidates):
                raise ValueError("candidate_index is out of range")
            item = replace(
                item,
                status=ReviewStatus.APPROVED,
                selected_character=item.candidates[candidate_index],
            )
            self._items[review_id] = item
            return item

    async def reject(self, *, user_id: str, review_id: str) -> ReviewItem:
        self._validate_user_id(user_id)
        async with self._lock:
            item = self._get_owned_item(user_id, review_id)
            if item.status is ReviewStatus.PENDING and self._now() >= item.expires_at:
                item = replace(item, status=ReviewStatus.EXPIRED)
                self._items[review_id] = item
                return item
            self._require_pending(item)
            item = replace(item, status=ReviewStatus.REJECTED)
            self._items[review_id] = item
            return item

    async def expire_old_items(self) -> int:
        async with self._lock:
            return self._expire_due_items(self._now())

    def _expire_due_items(self, now: datetime) -> int:
        expired = 0
        for review_id, item in tuple(self._items.items()):
            if item.status is ReviewStatus.PENDING and now >= item.expires_at:
                self._items[review_id] = replace(item, status=ReviewStatus.EXPIRED)
                expired += 1
        return expired

    def _get_owned_item(self, user_id: str, review_id: str) -> ReviewItem:
        if not isinstance(review_id, str) or not review_id:
            raise ValueError("review_id is required")
        item = self._items.get(review_id)
        if item is None or item.user_id != user_id:
            raise LookupError("review item not found")
        return item

    @staticmethod
    def _require_pending(item: ReviewItem) -> None:
        if item.status is not ReviewStatus.PENDING:
            raise ValueError("review item is already resolved")

    def _now(self) -> datetime:
        now = self._clock()
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("clock must return a timezone-aware datetime")
        return now.astimezone(timezone.utc)

    @staticmethod
    def _validate_user_id(user_id: str) -> None:
        if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")
