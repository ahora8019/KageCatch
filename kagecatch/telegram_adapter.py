"""Telethon-backed command adapter with an injected response verifier.

The adapter never initiates login or requests phone codes/2FA passwords. The
session lifecycle is handled separately by an explicitly authorized runtime.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Protocol

from .adapters import TARGETS, build_catch_command
from .engine import CatchReceipt, Spawn


class TelegramClient(Protocol):
    async def send_message(self, entity: str, message: str): ...


ResponseVerifier = Callable[[str, CatchReceipt], Awaitable[bool]]


class TelethonCatchAdapter:
    def __init__(
        self,
        *,
        source: str,
        client: TelegramClient,
        response_verifier: ResponseVerifier,
    ) -> None:
        target = TARGETS.get(source)
        if target is None:
            raise ValueError("unsupported catch source")
        if not target.enabled:
            raise RuntimeError("catch source is currently frozen")
        self.source = source
        self.target_username = target.username
        self._client = client
        self._response_verifier = response_verifier

    async def send_catch(self, spawn: Spawn, character_name: str) -> CatchReceipt:
        if spawn.source != self.source:
            raise ValueError("spawn source does not match adapter")
        if spawn.media_kind != TARGETS[self.source].media_kind:
            raise ValueError("spawn media kind does not match adapter")
        command = build_catch_command(self.source, character_name)
        response = await self._client.send_message(self.target_username, command)
        message_id = getattr(response, "id", None)
        if message_id is None:
            raise RuntimeError("Telegram did not return an outbound message id")
        return CatchReceipt(
            reference=f"{self.target_username}:{message_id}",
            character_name=character_name,
        )

    async def verify_catch(self, receipt: CatchReceipt) -> bool:
        return await self._response_verifier(self.target_username, receipt)
