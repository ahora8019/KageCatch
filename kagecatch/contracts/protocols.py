"""Structural interfaces for KageCatch domain and infrastructure boundaries."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping, Protocol

from .models import (
    CatchReceipt,
    RecognitionCandidate,
    RecognitionResult,
    SpawnEnvelope,
    TargetDefinition,
    VerificationResult,
)


class TargetRegistry(Protocol):
    def get(self, source_id: str) -> TargetDefinition | None: ...
    def all(self) -> tuple[TargetDefinition, ...]: ...


class RecognitionProvider(Protocol):
    async def recognize(self, *, spawn: SpawnEnvelope) -> RecognitionResult: ...


class ReviewStore(Protocol):
    async def enqueue(
        self, *, spawn: SpawnEnvelope, result: RecognitionResult
    ) -> str: ...
    async def get(self, item_id: str) -> Mapping[str, Any] | None: ...
    async def approve(self, *, item_id: str, actor_user_id: str) -> bool: ...
    async def reject(self, *, item_id: str, actor_user_id: str) -> bool: ...


class CatchAdapter(Protocol):
    source_id: str
    media_kind: str

    async def send_catch(
        self, *, spawn: SpawnEnvelope, candidate: RecognitionCandidate
    ) -> CatchReceipt: ...
    async def verify_catch(self, *, receipt: CatchReceipt) -> VerificationResult: ...


class QuotaGate(Protocol):
    """Atomically reserve one user/source operation before outbound dispatch."""

    async def reserve(
        self, *, user_id: str, source_id: str, operation_key: str,
        now: datetime | None = None,
    ) -> bool: ...


class Deduplicator(Protocol):
    async def claim(self, *, key: str, lease_seconds: int) -> bool: ...


class SessionAccessPolicy(Protocol):
    """Returns whether a stored account may be restored into a live runtime."""

    async def can_restore(self, *, user_id: str) -> bool: ...
