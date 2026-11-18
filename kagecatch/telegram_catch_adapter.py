"""Telethon-backed command adapter for supported character catcher bots.

Outbound commands require a local safety guard or an asynchronous shared
reservation. Distributed runtimes should use the shared reservation client.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import logging
import math
import time
from typing import Any, Protocol

from .adapters import TARGETS, build_catch_command
from .engine import CatchReceipt, Spawn
from .monitoring import emit_monitor_event
from .telegram_safety_guard import TelegramSafetyGuard


@dataclass(frozen=True, slots=True)
class SentCatch:
    receipt: CatchReceipt
    target_username: str
    outgoing_message: Any


ResponseVerifier = Callable[[Any, str, Any, CatchReceipt], Awaitable[bool]]


class DistributedTelegramSafetyClient(Protocol):
    async def reserve_outbound(
        self, owner_id: str, chat_id: int | str, *, minimum_interval_seconds: int = 1
    ) -> dict[str, Any]: ...

    async def update_backoff(
        self, owner_id: str, kind: str, until: int
    ) -> dict[str, Any]: ...

    async def set_owner_lock(
        self, owner_id: str, locked: bool, *, reason: str | None = None
    ) -> dict[str, Any]: ...


class TelethonCatchAdapter:
    """Send a catch command through an already-authorized Telethon client."""

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
        client: Any,
        source: str,
        response_verifier: ResponseVerifier | None = None,
        dispatch_enabled: bool = False,
        safety_guard: TelegramSafetyGuard | None = None,
        distributed_safety_client: DistributedTelegramSafetyClient | None = None,
        owner_id: str | None = None,
        minimum_interval_seconds: int = 1,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        target = TARGETS.get(source)
        if target is None:
            raise ValueError("unsupported catch source")
        if not target.enabled:
            raise RuntimeError("catch source is currently frozen")
        if dispatch_enabled and safety_guard is None and distributed_safety_client is None:
            raise RuntimeError("live dispatch requires a local or distributed Telegram safety gate")
        if distributed_safety_client is not None:
            if not isinstance(owner_id, str) or not owner_id:
                raise ValueError("owner_id is required for distributed Telegram safety")
            if (
                isinstance(minimum_interval_seconds, bool)
                or not isinstance(minimum_interval_seconds, int)
                or not 0 <= minimum_interval_seconds <= 60
            ):
                raise ValueError("minimum_interval_seconds must be an integer from 0 to 60")
        self.client = client
        self.source = source
        self.media_kind = target.media_kind
        self.target_username = target.username
        self.response_verifier = response_verifier
        self.dispatch_enabled = bool(dispatch_enabled)
        self.safety_guard = safety_guard
        self.distributed_safety_client = distributed_safety_client
        self.owner_id = owner_id
        self.minimum_interval_seconds = minimum_interval_seconds
        self._wall_clock = wall_clock
        self._sent: dict[str, Any] = {}

    async def _reserve_send(self, chat_id: int | str) -> None:
        if self.distributed_safety_client is not None:
            reservation = await self.distributed_safety_client.reserve_outbound(
                self.owner_id,
                chat_id,
                minimum_interval_seconds=self.minimum_interval_seconds,
            )
            if not isinstance(reservation, dict) or not isinstance(reservation.get("allowed"), bool):
                raise RuntimeError("distributed Telegram safety API returned an invalid reservation")
            if not reservation["allowed"]:
                reason = reservation.get("reason")
                if not isinstance(reason, str) or not reason:
                    reason = "distributed_safety_gate_blocked"
                emit_monitor_event("telegram_outbound_blocked", level=logging.WARNING)
                raise RuntimeError(f"distributed Telegram safety gate blocked outbound action: {reason}")
            return

        if self.safety_guard is None:
            raise RuntimeError("Telegram safety guard is unavailable")
        decision = self.safety_guard.reserve_send(chat_id=chat_id)
        if not decision.allowed:
            emit_monitor_event("telegram_outbound_blocked", level=logging.WARNING)
            raise RuntimeError(f"Telegram safety guard blocked outbound action: {decision.reason}")

    async def _record_distributed_error(self, error: BaseException) -> str:
        if self.distributed_safety_client is None:
            return "transient"
        name = type(error).__name__.lower()
        seconds = getattr(error, "seconds", None)
        retry_after = getattr(error, "retry_after", None)
        if name == "floodwaiterror" or seconds is not None:
            delay = seconds
            kind = "flood_wait"
        elif retry_after is not None:
            delay = retry_after
            kind = "bot_retry_after"
        elif name in self._SESSION_FAILURES:
            await self.distributed_safety_client.set_owner_lock(
                self.owner_id, True, reason="session_revoked"
            )
            return "session_revoked"
        elif name in self._SECURITY_FAILURES:
            await self.distributed_safety_client.set_owner_lock(
                self.owner_id, True, reason="telegram_security_lock"
            )
            return "security_lock"
        else:
            return "transient"

        if (
            isinstance(delay, bool)
            or not isinstance(delay, (int, float))
            or not math.isfinite(delay)
            or delay <= 0
            or delay > 86400
        ):
            return "transient"
        await self.distributed_safety_client.update_backoff(
            self.owner_id, kind, int(self._wall_clock() + delay)
        )
        return "rate_limit"

    async def send_catch(self, spawn: Spawn, character_name: str) -> CatchReceipt:
        if not self.dispatch_enabled:
            raise RuntimeError("live catch dispatch is disabled")
        if spawn.source != self.source or spawn.media_kind != self.media_kind:
            raise ValueError("spawn does not match this catcher")
        await self._reserve_send(spawn.chat_id)

        command = build_catch_command(self.source, character_name)
        try:
            message = await self.client.send_message(self.target_username, command)
        except Exception as exc:
            event_category = "transient"
            if self.safety_guard is not None:
                event_category = self.safety_guard.observe_error(exc).category
            if self.distributed_safety_client is not None:
                try:
                    distributed_category = await self._record_distributed_error(exc)
                except Exception as safety_error:
                    raise RuntimeError(
                        "distributed Telegram safety state update failed; refusing further catch dispatch"
                    ) from safety_error
                if distributed_category != "transient":
                    event_category = distributed_category
            if event_category == "rate_limit":
                emit_monitor_event("flood_wait", level=logging.WARNING)
            elif event_category == "session_revoked":
                emit_monitor_event("session_revoked", level=logging.ERROR)
                await self._disconnect_after_session_loss()
            elif event_category == "security_lock":
                emit_monitor_event("telegram_security_lock", level=logging.CRITICAL)
                await self._disconnect_after_session_loss()
            raise

        message_id = getattr(message, "id", None)
        if not isinstance(message_id, int) or message_id <= 0:
            raise RuntimeError("Telegram did not return a sent message identifier")
        reference = f"{self.target_username}:{message_id}"
        receipt = CatchReceipt(reference=reference, character_name=character_name)
        self._sent[reference] = message
        return receipt

    async def _disconnect_after_session_loss(self) -> None:
        disconnect = getattr(self.client, "disconnect", None)
        if disconnect is None:
            return
        try:
            result = disconnect()
            if hasattr(result, "__await__"):
                await result
        except Exception:
            # Safety lock remains active even if transport cleanup fails.
            pass

    async def verify_catch(self, receipt: CatchReceipt) -> bool:
        message = self._sent.get(receipt.reference)
        if message is None or self.response_verifier is None:
            return False
        return bool(
            await self.response_verifier(
                self.client, self.target_username, message, receipt
            )
        )
