"""Fail-closed outbound Telegram safety gate.

This module is deliberately transport-agnostic and has no Telegram dependency.
It classifies known restriction/session failures, enforces conservative local
cooldowns, and requires explicit operator action before clearing manual locks.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Callable


class GuardMode(str, Enum):
    OPEN = "open"
    RATE_LIMITED = "rate_limited"
    SESSION_LOCKED = "session_locked"
    SECURITY_LOCKED = "security_locked"
    MANUAL_LOCKED = "manual_locked"


@dataclass(frozen=True, slots=True)
class SendDecision:
    allowed: bool
    reason: str
    retry_after: float = 0.0


@dataclass(frozen=True, slots=True)
class SafetyEvent:
    category: str
    code: str
    retry_after: float = 0.0


class TelegramSafetyGuard:
    """In-memory guard for one authorized Telegram account/session runtime.

    The caller must reserve a send slot immediately before every outbound
    action. Reservation is synchronous/atomic within one Python event loop.
    Distributed deployments must coordinate this state in a shared store
    before enabling multiple workers.
    """

    _SESSION_FAILURES = {
        "sessionrevokederror",
        "authkeyunregisterederror",
        "userdeactivatederror",
        "sessionauthorizationlosterror",
    }
    _SECURITY_FAILURES = {
        "authkeyduplicatederror",
        "phonenumberbanned",
        "userdeactivatedbanerror",
    }

    def __init__(
        self,
        *,
        clock: Callable[[], float],
        min_global_interval: float = 1.0,
        min_chat_interval: float = 1.0,
    ) -> None:
        for name, value in (
            ("min_global_interval", min_global_interval),
            ("min_chat_interval", min_chat_interval),
        ):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
                raise ValueError(f"{name} must be a non-negative number")
        self._clock = clock
        self.min_global_interval = float(min_global_interval)
        self.min_chat_interval = float(min_chat_interval)
        self.mode = GuardMode.OPEN
        self._cooldown_until = 0.0
        self._last_global_send: float | None = None
        self._last_chat_send: dict[int | str, float] = {}

    def check_send(self, *, chat_id: int | str) -> SendDecision:
        now = float(self._clock())
        if self.mode == GuardMode.RATE_LIMITED:
            remaining = self._cooldown_until - now
            if remaining > 0:
                return SendDecision(False, "telegram_rate_limit", remaining)
            self.mode = GuardMode.OPEN
            self._cooldown_until = 0.0
        if self.mode != GuardMode.OPEN:
            return SendDecision(False, self.mode.value)
        if self._last_global_send is not None:
            remaining = self.min_global_interval - (now - self._last_global_send)
            if remaining > 0:
                return SendDecision(False, "global_cooldown", remaining)
        last_chat = self._last_chat_send.get(chat_id)
        if last_chat is not None:
            remaining = self.min_chat_interval - (now - last_chat)
            if remaining > 0:
                return SendDecision(False, "chat_cooldown", remaining)
        return SendDecision(True, "allowed")

    def reserve_send(self, *, chat_id: int | str) -> SendDecision:
        """Atomically consume a send slot before yielding to network I/O."""
        decision = self.check_send(chat_id=chat_id)
        if not decision.allowed:
            return decision
        now = float(self._clock())
        self._last_global_send = now
        self._last_chat_send[chat_id] = now
        return decision

    def record_send(self, *, chat_id: int | str) -> None:
        """Compatibility wrapper; new callers should reserve before network I/O."""
        decision = self.reserve_send(chat_id=chat_id)
        if not decision.allowed:
            raise RuntimeError(f"outbound Telegram operation blocked: {decision.reason}")

    def observe_error(self, error: BaseException) -> SafetyEvent:
        name = type(error).__name__.lower()
        if name in self._SECURITY_FAILURES:
            self.mode = GuardMode.SECURITY_LOCKED
            self._cooldown_until = 0.0
            return SafetyEvent("security_lock", type(error).__name__)
        if name in self._SESSION_FAILURES:
            self.mode = GuardMode.SESSION_LOCKED
            self._cooldown_until = 0.0
            return SafetyEvent("session_revoked", type(error).__name__)
        retry_after = self._retry_after(error)
        if retry_after > 0 and ("floodwait" in name or hasattr(error, "retry_after")):
            self.mode = GuardMode.RATE_LIMITED
            self._cooldown_until = max(self._cooldown_until, float(self._clock()) + retry_after)
            return SafetyEvent("rate_limit", type(error).__name__, retry_after)
        return SafetyEvent("transient", type(error).__name__)

    def lock(self, *, reason: str = "operator") -> None:
        self.mode = GuardMode.MANUAL_LOCKED
        self._cooldown_until = 0.0

    def clear_lock(
        self,
        *,
        operator_confirmed: bool,
        session_reauthorized: bool,
        security_reviewed: bool = False,
    ) -> bool:
        if not operator_confirmed:
            return False
        if self.mode == GuardMode.SESSION_LOCKED and not session_reauthorized:
            return False
        if self.mode == GuardMode.SECURITY_LOCKED and not (
            session_reauthorized and security_reviewed
        ):
            return False
        if self.mode == GuardMode.RATE_LIMITED:
            return False
        self.mode = GuardMode.OPEN
        self._cooldown_until = 0.0
        self._last_global_send = None
        self._last_chat_send.clear()
        return True

    @staticmethod
    def _retry_after(error: BaseException) -> float:
        raw = getattr(error, "retry_after", None)
        if raw is None and "floodwait" in type(error).__name__.lower():
            raw = getattr(error, "seconds", None)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            return 0.0
        return max(0.0, min(float(raw), 86400.0))
