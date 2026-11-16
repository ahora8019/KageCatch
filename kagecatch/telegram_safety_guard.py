"""Fail-closed outbound Telegram safety gate with optional durable state.

Local SQLite is for one host and one active runtime only. Distributed workers
must use a shared atomic coordinator before they can be enabled.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import math
import time
from typing import Any, Callable, Protocol


class SafetyStateStore(Protocol):
    def load(self, owner_id: str) -> dict[str, Any] | None: ...
    def save(self, owner_id: str, state: dict[str, Any]) -> None: ...


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
    """Per-owner outbound guard; durable locks survive process restarts.

    The caller must reserve a send slot immediately before every outbound
    action. In-memory reservations are atomic within one event loop. SQLite
    state persistence is single-host only and does not coordinate multiple
    processes performing sends concurrently.
    """

    _SESSION_FAILURES = {
        "sessionrevokederror", "authkeyunregisterederror", "userdeactivatederror",
        "sessionauthorizationlosterror",
    }
    _SECURITY_FAILURES = {
        "authkeyduplicatederror", "phonenumberbanned", "userdeactivatedbanerror",
    }

    def __init__(
        self, *, clock: Callable[[], float], min_global_interval: float = 1.0,
        min_chat_interval: float = 1.0, state_store: SafetyStateStore | None = None,
        owner_id: str | None = None, wall_clock: Callable[[], float] = time.time,
    ) -> None:
        for name, value in (
            ("min_global_interval", min_global_interval),
            ("min_chat_interval", min_chat_interval),
        ):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be a non-negative finite number")
        if (state_store is None) != (owner_id is None):
            raise ValueError("state_store and owner_id must be provided together")
        if owner_id is not None and (not isinstance(owner_id, str) or not owner_id or len(owner_id) > 128):
            raise ValueError("valid owner_id is required")

        self._clock = clock
        self._wall_clock = wall_clock
        self._state_store = state_store
        self._owner_id = owner_id
        self.min_global_interval = float(min_global_interval)
        self.min_chat_interval = float(min_chat_interval)
        self.mode = GuardMode.OPEN
        self.lock_reason: str | None = None
        self._cooldown_until = 0.0
        self._last_global_send: float | None = None
        self._last_chat_send: dict[str, float] = {}
        if self._state_store is not None:
            self._restore_state()

    @staticmethod
    def _chat_key(chat_id: int | str) -> str:
        if isinstance(chat_id, bool) or not isinstance(chat_id, (int, str)):
            raise ValueError("chat_id must be an integer or string")
        key = str(chat_id)
        if not key or len(key) > 64:
            raise ValueError("chat_id must contain 1 to 64 characters")
        return key

    @staticmethod
    def _finite_state_number(value: Any, field: str, *, default: float = 0.0) -> float:
        if value is None:
            value = default
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"invalid {field} in Telegram safety state")
        return float(value)

    def _restore_state(self) -> None:
        try:
            state = self._state_store.load(self._owner_id)  # type: ignore[union-attr]
            if state is None:
                return
            if not isinstance(state, dict) or state.get("version") != 1:
                raise ValueError("unsupported Telegram safety state schema")
            raw_mode = state.get("mode")
            if not isinstance(raw_mode, str):
                raise ValueError("missing Telegram safety mode")
            mode = GuardMode(raw_mode)
            lock_reason = state.get("lock_reason")
            if lock_reason is not None and (
                not isinstance(lock_reason, str) or not lock_reason or len(lock_reason) > 128
            ):
                raise ValueError("invalid Telegram safety lock reason")

            now_mono = self._finite_state_number(self._clock(), "monotonic clock")
            now_wall = self._finite_state_number(self._wall_clock(), "wall clock")
            cooldown_epoch = self._finite_state_number(state.get("cooldown_until_epoch"), "cooldown deadline")
            self.mode = mode
            self.lock_reason = lock_reason
            if mode == GuardMode.RATE_LIMITED:
                remaining = max(0.0, cooldown_epoch - now_wall)
                if remaining:
                    self._cooldown_until = now_mono + remaining
                else:
                    self.mode = GuardMode.OPEN
                    self.lock_reason = None

            last_global_epoch = state.get("last_global_send_epoch")
            if last_global_epoch is not None:
                last_global_epoch = self._finite_state_number(last_global_epoch, "last global send time")
                age = max(0.0, now_wall - last_global_epoch)
                self._last_global_send = now_mono - age

            chat_epochs = state.get("last_chat_send_epochs", {})
            if not isinstance(chat_epochs, dict) or len(chat_epochs) > 1000:
                raise ValueError("invalid chat pacing state")
            for chat_id, timestamp in chat_epochs.items():
                if not isinstance(chat_id, str) or not chat_id or len(chat_id) > 64:
                    raise ValueError("invalid chat identifier in pacing state")
                sent_epoch = self._finite_state_number(timestamp, "chat send time")
                age = max(0.0, now_wall - sent_epoch)
                self._last_chat_send[chat_id] = now_mono - age
        except Exception as exc:
            self.mode = GuardMode.SECURITY_LOCKED
            self.lock_reason = "safety_state_restore_failed"
            self._cooldown_until = 0.0
            raise RuntimeError(
                "Telegram safety state could not be restored; outbound actions remain locked"
            ) from exc

    def _persist_state(self) -> None:
        if self._state_store is None:
            return
        now_mono = float(self._clock())
        now_wall = float(self._wall_clock())
        state = {
            "version": 1,
            "mode": self.mode.value,
            "lock_reason": self.lock_reason,
            "cooldown_until_epoch": (
                now_wall + max(0.0, self._cooldown_until - now_mono)
                if self.mode == GuardMode.RATE_LIMITED else 0.0
            ),
            "last_global_send_epoch": (
                now_wall - max(0.0, now_mono - self._last_global_send)
                if self._last_global_send is not None else None
            ),
            "last_chat_send_epochs": {
                chat_id: now_wall - max(0.0, now_mono - timestamp)
                for chat_id, timestamp in self._last_chat_send.items()
            },
        }
        self._state_store.save(self._owner_id, state)  # type: ignore[union-attr]

    def check_send(self, *, chat_id: int | str) -> SendDecision:
        key = self._chat_key(chat_id)
        now = float(self._clock())
        if self.mode == GuardMode.RATE_LIMITED:
            remaining = self._cooldown_until - now
            if remaining > 0:
                return SendDecision(False, "telegram_rate_limit", remaining)
            self.mode = GuardMode.OPEN
            self.lock_reason = None
            self._cooldown_until = 0.0
            self._persist_state()
        if self.mode != GuardMode.OPEN:
            return SendDecision(False, self.mode.value)
        if self._last_global_send is not None:
            remaining = self.min_global_interval - (now - self._last_global_send)
            if remaining > 0:
                return SendDecision(False, "global_cooldown", remaining)
        last_chat = self._last_chat_send.get(key)
        if last_chat is not None:
            remaining = self.min_chat_interval - (now - last_chat)
            if remaining > 0:
                return SendDecision(False, "chat_cooldown", remaining)
        return SendDecision(True, "allowed")

    def reserve_send(self, *, chat_id: int | str) -> SendDecision:
        decision = self.check_send(chat_id=chat_id)
        if not decision.allowed:
            return decision
        now = float(self._clock())
        self._last_global_send = now
        self._last_chat_send[self._chat_key(chat_id)] = now
        self._persist_state()
        return decision

    def record_send(self, *, chat_id: int | str) -> None:
        decision = self.reserve_send(chat_id=chat_id)
        if not decision.allowed:
            raise RuntimeError(f"outbound Telegram operation blocked: {decision.reason}")

    def observe_error(self, error: BaseException) -> SafetyEvent:
        name = type(error).__name__.lower()
        if name in self._SECURITY_FAILURES:
            self.mode = GuardMode.SECURITY_LOCKED
            self.lock_reason = type(error).__name__[:128]
            self._cooldown_until = 0.0
            self._persist_state()
            return SafetyEvent("security_lock", type(error).__name__)
        if name in self._SESSION_FAILURES:
            self.mode = GuardMode.SESSION_LOCKED
            self.lock_reason = type(error).__name__[:128]
            self._cooldown_until = 0.0
            self._persist_state()
            return SafetyEvent("session_revoked", type(error).__name__)
        retry_after = self._retry_after(error)
        if retry_after > 0 and ("floodwait" in name or hasattr(error, "retry_after")):
            self.mode = GuardMode.RATE_LIMITED
            self.lock_reason = "telegram_rate_limit"
            self._cooldown_until = max(self._cooldown_until, float(self._clock()) + retry_after)
            self._persist_state()
            return SafetyEvent("rate_limit", type(error).__name__, retry_after)
        return SafetyEvent("transient", type(error).__name__)

    def lock(self, *, reason: str = "operator") -> None:
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 128:
            raise ValueError("lock reason must contain 1 to 128 characters")
        self.mode = GuardMode.MANUAL_LOCKED
        self.lock_reason = reason.strip()
        self._cooldown_until = 0.0
        self._persist_state()

    def clear_lock(
        self, *, operator_confirmed: bool, session_reauthorized: bool,
        security_reviewed: bool = False,
    ) -> bool:
        if not operator_confirmed:
            return False
        if self.mode == GuardMode.SESSION_LOCKED and not session_reauthorized:
            return False
        if self.mode == GuardMode.SECURITY_LOCKED and not (session_reauthorized and security_reviewed):
            return False
        if self.mode == GuardMode.RATE_LIMITED:
            return False
        self.mode = GuardMode.OPEN
        self.lock_reason = None
        self._cooldown_until = 0.0
        self._last_global_send = None
        self._last_chat_send.clear()
        self._persist_state()
        return True

    @staticmethod
    def _retry_after(error: BaseException) -> float:
        raw = getattr(error, "retry_after", None)
        if raw is None and "floodwait" in type(error).__name__.lower():
            raw = getattr(error, "seconds", None)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
            return 0.0
        return max(0.0, min(float(raw), 86400.0))
