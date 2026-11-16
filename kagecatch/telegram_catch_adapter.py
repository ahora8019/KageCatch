"""Telethon-backed command adapter for supported character catcher bots.

Outbound commands are gated by TelegramSafetyGuard. Live dispatch stays disabled
unless explicitly enabled and a guard is injected by the runtime composition.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .adapters import TARGETS, build_catch_command
from .engine import CatchReceipt, Spawn
from .telegram_safety_guard import TelegramSafetyGuard


@dataclass(frozen=True, slots=True)
class SentCatch:
    receipt: CatchReceipt
    target_username: str
    outgoing_message: Any


ResponseVerifier = Callable[[Any, str, Any, CatchReceipt], Awaitable[bool]]


class TelethonCatchAdapter:
    """Send a catch command through an already-authorized Telethon client."""

    def __init__(
        self,
        *,
        client: Any,
        source: str,
        response_verifier: ResponseVerifier | None = None,
        dispatch_enabled: bool = False,
        safety_guard: TelegramSafetyGuard | None = None,
    ) -> None:
        target = TARGETS.get(source)
        if target is None:
            raise ValueError("unsupported catch source")
        if not target.enabled:
            raise RuntimeError("catch source is currently frozen")
        if dispatch_enabled and safety_guard is None:
            raise RuntimeError("live dispatch requires TelegramSafetyGuard")
        self.client = client
        self.source = source
        self.media_kind = target.media_kind
        self.target_username = target.username
        self.response_verifier = response_verifier
        self.dispatch_enabled = bool(dispatch_enabled)
        self.safety_guard = safety_guard
        self._sent: dict[str, Any] = {}

    async def send_catch(self, spawn: Spawn, character_name: str) -> CatchReceipt:
        if not self.dispatch_enabled:
            raise RuntimeError("live catch dispatch is disabled")
        if spawn.source != self.source or spawn.media_kind != self.media_kind:
            raise ValueError("spawn does not match this catcher")
        if self.safety_guard is None:
            raise RuntimeError("Telegram safety guard is unavailable")
        decision = self.safety_guard.check_send(chat_id=spawn.chat_id)
        if not decision.allowed:
            raise RuntimeError(f"Telegram safety guard blocked outbound action: {decision.reason}")

        command = build_catch_command(self.source, character_name)
        try:
            message = await self.client.send_message(self.target_username, command)
        except Exception as exc:
            self.safety_guard.observe_error(exc)
            raise

        # The API accepted the send even if the response object is malformed.
        self.safety_guard.record_send(chat_id=spawn.chat_id)
        message_id = getattr(message, "id", None)
        if not isinstance(message_id, int) or message_id <= 0:
            raise RuntimeError("Telegram did not return a sent message identifier")
        reference = f"{self.target_username}:{message_id}"
        receipt = CatchReceipt(reference=reference, character_name=character_name)
        self._sent[reference] = message
        return receipt

    async def verify_catch(self, receipt: CatchReceipt) -> bool:
        message = self._sent.get(receipt.reference)
        if message is None or self.response_verifier is None:
            return False
        return bool(
            await self.response_verifier(
                self.client, self.target_username, message, receipt
            )
        )
