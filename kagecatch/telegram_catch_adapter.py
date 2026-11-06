"""Telethon-backed command adapter for supported character catcher bots.

Dispatch is intentionally separate from verification: sending a command never
counts as a successful catch. A target-specific response verifier must be
provided before a receipt can be marked verified.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .adapters import TARGETS, build_catch_command
from .engine import CatchReceipt, Spawn


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
    ) -> None:
        target = TARGETS.get(source)
        if target is None:
            raise ValueError("unsupported catch source")
        if not target.enabled:
            raise RuntimeError("catch source is currently frozen")
        self.client = client
        self.source = source
        self.media_kind = target.media_kind
        self.target_username = target.username
        self.response_verifier = response_verifier
        self._sent: dict[str, Any] = {}

    async def send_catch(self, spawn: Spawn, character_name: str) -> CatchReceipt:
        if spawn.source != self.source or spawn.media_kind != self.media_kind:
            raise ValueError("spawn does not match this catcher")
        command = build_catch_command(self.source, character_name)
        message = await self.client.send_message(self.target_username, command)
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
