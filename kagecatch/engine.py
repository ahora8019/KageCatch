"""Framework-independent and fail-safe Catch orchestration."""
from __future__ import annotations

import asyncio
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol


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
    media_kind: str

    async def send_catch(self, spawn: Spawn, character_name: str) -> CatchReceipt: ...

    async def verify_catch(self, receipt: CatchReceipt) -> bool: ...


class QuotaGate(Protocol):
    async def allow(self, user_id: str, source: str) -> bool: ...


class Deduplicator(Protocol):
    async def claim(self, key: str) -> bool: ...


class CatchAdmission(Protocol):
    async def reserve(
        self, *, user_id: str, source: str, dedupe_key: str
    ) -> str: ...


class InMemoryDeduplicator:
    """Development-only dedupe; production should use CatchAdmission."""

    def __init__(self) -> None:
        self._seen: set[str] = set()
        self._lock = asyncio.Lock()

    async def claim(self, key: str) -> bool:
        async with self._lock:
            if key in self._seen:
                return False
            self._seen.add(key)
            return True


_USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SOURCE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_ALLOWED_MEDIA = {"image", "video"}
_MAX_CANDIDATES = 30


class CatchEngine:
    def __init__(
        self,
        *,
        confidence_threshold: float,
        admission: CatchAdmission | None = None,
        quota: QuotaGate | None = None,
        deduplicator: Deduplicator | None = None,
        enabled: bool = False,
    ) -> None:
        try:
            threshold = float(confidence_threshold)
        except (TypeError, ValueError, OverflowError):
            raise ValueError("confidence_threshold must be between 0 and 1") from None
        if (
            isinstance(confidence_threshold, bool)
            or not isinstance(confidence_threshold, (int, float))
            or not math.isfinite(threshold)
            or not 0.0 <= threshold <= 1.0
        ):
            raise ValueError("confidence_threshold must be between 0 and 1")
        if admission is not None and (quota is not None or deduplicator is not None):
            raise ValueError("admission cannot be combined with separate quota/deduplicator gates")
        if enabled and admission is None:
            raise ValueError("enabled Catch Engine requires an atomic admission gate")
        if admission is None and ((quota is None) != (deduplicator is None)):
            raise ValueError("legacy quota and deduplicator must be supplied together")

        self.confidence_threshold = threshold
        self.admission = admission
        self.quota = quota
        self.deduplicator = deduplicator
        self.enabled = bool(enabled)

    async def handle_spawn(
        self,
        user_id: str,
        spawn: Spawn,
        adapter: CatchAdapter,
    ) -> CatchResult:
        self._validate_user_id(user_id)
        if not self.enabled:
            return CatchResult(status="disabled")
        self._validate_spawn(spawn)

        if getattr(adapter, "source", None) != spawn.source:
            return CatchResult(status="adapter_mismatch")
        if getattr(adapter, "media_kind", None) != spawn.media_kind:
            return CatchResult(status="media_mismatch")
        if not spawn.candidates:
            return CatchResult(status="no_match")

        valid: list[Candidate] = []
        for candidate in spawn.candidates:
            name = getattr(candidate, "name", None)
            confidence = getattr(candidate, "confidence", None)
            if not isinstance(name, str):
                continue
            normalized_name = name.strip()
            if (
                not normalized_name
                or len(normalized_name) > 100
                or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in normalized_name)
                or isinstance(confidence, bool)
                or not isinstance(confidence, (int, float))
            ):
                continue
            try:
                confidence_value = float(confidence)
            except (TypeError, ValueError, OverflowError):
                continue
            if not math.isfinite(confidence_value) or not 0.0 <= confidence_value <= 1.0:
                continue
            valid.append(Candidate(name=normalized_name, confidence=confidence_value))

        if not valid:
            return CatchResult(status="no_match")

        best = max(valid, key=lambda item: item.confidence)
        if best.confidence < self.confidence_threshold:
            return CatchResult(
                status="needs_review",
                character_name=best.name,
                confidence=best.confidence,
            )

        dedupe_key = f"{user_id}:{spawn.source}:{spawn.chat_id}:{spawn.message_id}"
        admission_status = await self._reserve_admission(user_id, spawn.source, dedupe_key)
        if admission_status != "admitted":
            return CatchResult(
                status=admission_status,
                character_name=best.name,
                confidence=best.confidence,
            )

        try:
            receipt = await adapter.send_catch(spawn, best.name)
        except Exception:
            # Keep the admission reservation. A network failure may have happened
            # after Telegram accepted the command; an automatic retry is unsafe.
            return CatchResult(
                status="send_failed",
                character_name=best.name,
                confidence=best.confidence,
            )

        if not self._valid_receipt(receipt, best.name):
            return CatchResult(
                status="invalid_receipt",
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

    async def _reserve_admission(
        self, user_id: str, source: str, dedupe_key: str
    ) -> str:
        try:
            if self.admission is not None:
                decision = await self.admission.reserve(
                    user_id=user_id, source=source, dedupe_key=dedupe_key
                )
                if decision in {"admitted", "duplicate", "quota_blocked"}:
                    return decision
                return "admission_unavailable"

            # Backward-compatible development path. It is not atomic; persistent
            # enabled deployments must inject SQLiteCatchAdmissionStore.
            if not await self.quota.allow(user_id, source):
                return "quota_blocked"
            if not await self.deduplicator.claim(dedupe_key):
                return "duplicate"
            return "admitted"
        except Exception:
            return "admission_unavailable"

    @staticmethod
    def _validate_user_id(user_id: str) -> None:
        if not isinstance(user_id, str) or not _USER_ID_RE.fullmatch(user_id):
            raise ValueError("user_id must be a canonical identifier")

    @staticmethod
    def _validate_spawn(spawn: Spawn) -> None:
        if not isinstance(spawn, Spawn):
            raise ValueError("spawn must be a Spawn instance")
        if not isinstance(spawn.source, str) or not _SOURCE_RE.fullmatch(spawn.source):
            raise ValueError("spawn source must be a canonical identifier")
        if isinstance(spawn.chat_id, bool) or not isinstance(spawn.chat_id, int) or spawn.chat_id == 0:
            raise ValueError("spawn chat_id must be a non-zero integer")
        if isinstance(spawn.message_id, bool) or not isinstance(spawn.message_id, int) or spawn.message_id <= 0:
            raise ValueError("spawn message_id must be a positive integer")
        if not isinstance(spawn.media_kind, str) or spawn.media_kind not in _ALLOWED_MEDIA:
            raise ValueError("spawn media_kind must be image or video")
        if (
            not isinstance(spawn.candidates, Sequence)
            or isinstance(spawn.candidates, (str, bytes, bytearray))
            or len(spawn.candidates) > _MAX_CANDIDATES
        ):
            raise ValueError("spawn candidates must be a bounded sequence")

    @staticmethod
    def _valid_receipt(receipt: object, expected_name: str) -> bool:
        if not isinstance(receipt, CatchReceipt):
            return False
        reference = receipt.reference
        character_name = receipt.character_name
        if (
            not isinstance(reference, str)
            or not reference.strip()
            or len(reference) > 256
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in reference)
        ):
            return False
        return isinstance(character_name, str) and character_name == expected_name
