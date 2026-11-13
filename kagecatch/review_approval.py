"""Explicit human-approval gate between manual review and CatchEngine.

The spawn loader must retrieve the original normalized event context from a
trusted server-side source. Telegram event objects and user-supplied metadata
are never accepted from the approval request itself.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from .engine import Candidate, CatchEngine, CatchResult, Spawn
from .manual_review_queue import ReviewStatus


SpawnLoader = Callable[[str, int], Awaitable[Spawn | None]]
AdapterResolver = Callable[[str], Any]


class ReviewApprovalService:
    """Approve one queued candidate and hand it to the guarded CatchEngine.

    This service does not enable CatchEngine. A disabled engine remains a hard
    stop even after a human has selected a candidate.
    """

    def __init__(
        self,
        *,
        review_queue,
        spawn_loader: SpawnLoader,
        engine: CatchEngine,
        adapter_resolver: AdapterResolver,
    ) -> None:
        if not callable(spawn_loader):
            raise TypeError("spawn_loader must be callable")
        if not callable(adapter_resolver):
            raise TypeError("adapter_resolver must be callable")
        self.review_queue = review_queue
        self.spawn_loader = spawn_loader
        self.engine = engine
        self.adapter_resolver = adapter_resolver

    async def approve_and_execute(
        self,
        *,
        user_id: str,
        review_id: str,
        candidate_index: int,
    ) -> CatchResult:
        if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")
        if not isinstance(review_id, str) or not review_id:
            raise ValueError("review_id is required")
        if isinstance(candidate_index, bool) or not isinstance(candidate_index, int):
            raise ValueError("candidate_index must be an integer")

        # The queue's per-user listing deliberately makes foreign IDs
        # indistinguishable from unknown IDs.
        pending = await self.review_queue.get_pending(user_id=user_id)
        item = next((entry for entry in pending if entry.review_id == review_id), None)
        if item is None:
            raise LookupError("review item not found")
        if not 0 <= candidate_index < len(item.candidates):
            raise ValueError("candidate_index is out of range")

        # Never consume an approval when execution is globally disabled.
        if not self.engine.enabled:
            return CatchResult(status="disabled")

        spawn = await self.spawn_loader(user_id, item.spawn_id)
        if spawn is None:
            raise LookupError("original spawn context not found")
        if not isinstance(spawn, Spawn):
            raise TypeError("spawn loader returned an invalid context")
        if spawn.message_id != item.spawn_id:
            raise ValueError("spawn context does not match review item")

        adapter = self.adapter_resolver(spawn.source)
        if adapter is None:
            return CatchResult(status="adapter_unavailable")
        if getattr(adapter, "source", None) != spawn.source:
            return CatchResult(status="adapter_mismatch")
        if getattr(adapter, "media_kind", None) != spawn.media_kind:
            return CatchResult(status="media_mismatch")

        approved = await self.review_queue.approve(
            user_id=user_id,
            review_id=review_id,
            candidate_index=candidate_index,
        )
        if approved.status is ReviewStatus.EXPIRED:
            return CatchResult(status="expired")
        if approved.status is not ReviewStatus.APPROVED or not approved.selected_character:
            return CatchResult(status="approval_rejected")

        # Confidence 1.0 here represents the explicit human selection, not
        # machine recognition confidence. The engine still enforces quota,
        # deduplication, adapter compatibility, and post-send verification.
        approved_spawn = Spawn(
            source=spawn.source,
            chat_id=spawn.chat_id,
            message_id=spawn.message_id,
            media_kind=spawn.media_kind,
            candidates=(Candidate(approved.selected_character, 1.0),),
        )
        return await self.engine.handle_spawn(user_id, approved_spawn, adapter)
