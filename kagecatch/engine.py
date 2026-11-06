"""Framework-independent orchestration for KageCatch.

This module deliberately does not create Telegram user sessions or send messages
itself. A source-specific adapter performs those operations after explicit
session authorization is implemented in the execution layer.
"""
from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from typing import Protocol, Sequence


@dataclass(frozen=True, slots=True)
class Candidate:
    name: str
    confidence: float


@dataclass(frozen=True, slots=True)
class Spawn:
    source: str
    chat_id: int
    message_id: int
    media_kind: str
    candidates: Sequence[Candidate]


@dataclass(frozen=True, slots=True)
class CatchReceipt:
    reference: str
    character_name: str


@dataclass(frozen=True, slots=True)
class CatchResult:
    status: str
    character_name: str | None = None
    confidence: float | None = None
    receipt_reference: str | None = None


class CatchAdapter(Protocol):
    source: str

    async def send_catch(self, spawn: Spawn, character_name: str) -> CatchReceipt: ...

    async def verify_catch(self, receipt: CatchReceipt) -> bool: ...


class QuotaGate(Protocol):
    async def allow(self, user_id: str, source: str) -> bool: ...


class Deduplicator(Protocol):
    async def claim(self, key: str) -> bool: ...


class InMemoryDeduplicator:
    """Development-only dedupe; replace with an atomic persistent store."""

    def __init__(self) -> None:
        self._seen: set[str] = set()
        self._lock = asyncio.Lock()

    async def claim(self, key: str) -> bool:
        async with self._lock:
            if key in self._seen:
                return False
            self._seen.add(key)
            return True


class CatchEngine:
    def __init__(
        self,
        *,
        confidence_threshold: float,
        quota: QuotaGate,
        deduplicator: Deduplicator,
    ) -> None:
        if not math.isfinite(confidence_threshold) or not 0.0 <= confidence_threshold <= 1.0:
            raise ValueError("confidence_threshold must be between 0 and 1")
        self.confidence_threshold = confidence_threshold
        self.quota = quota
        self.deduplicator = deduplicator

    async def handle_spawn(
        self,
        user_id: str,
        spawn: Spawn,
        adapter: CatchAdapter,
    ) -> CatchResult:
        if not user_id:
            raise ValueError("user_id is required")
        if adapter.source != spawn.source:
            return CatchResult(status="adapter_mismatch")
        if not spawn.candidates:
            return CatchResult(status="no_match")

        valid = [
            candidate
            for candidate in spawn.candidates
            if candidate.name.strip()
            and math.isfinite(candidate.confidence)
            and 0.0 <= candidate.confidence <= 1.0
        ]
        if not valid:
            return CatchResult(status="no_match")

        best = max(valid, key=lambda item: item.confidence)
        if best.confidence < self.confidence_threshold:
            return CatchResult(
                status="needs_review",
                character_name=best.name,
                confidence=best.confidence,
            )

        if not await self.quota.allow(user_id, spawn.source):
            return CatchResult(
                status="quota_blocked",
                character_name=best.name,
                confidence=best.confidence,
            )

        dedupe_key = f"{user_id}:{spawn.source}:{spawn.chat_id}:{spawn.message_id}"
        if not await self.deduplicator.claim(dedupe_key):
            return CatchResult(
                status="duplicate",
                character_name=best.name,
                confidence=best.confidence,
            )

        try:
            receipt = await adapter.send_catch(spawn, best.name)
        except Exception:
            return CatchResult(
                status="send_failed",
                character_name=best.name,
                confidence=best.confidence,
            )

        try:
            verified = await adapter.verify_catch(receipt)
        except Exception:
            verified = False

        return CatchResult(
            status="verified" if verified else "unverified",
            character_name=best.name,
            confidence=best.confidence,
            receipt_reference=receipt.reference,
        )
