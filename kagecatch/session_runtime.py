"""Lifecycle manager for explicitly authorized, per-user Telethon sessions.

This runtime never performs interactive login. It only reconnects sessions that
were previously authorized and stored through SessionManager.
"""
from __future__ import annotations

import asyncio
from typing import Callable, Protocol

from .session_manager import SessionManager
from .monitoring import emit_monitor_event


class RuntimeClient(Protocol):
    async def connect(self) -> None: ...
    async def is_user_authorized(self) -> bool: ...
    async def disconnect(self) -> None: ...


ClientFactory = Callable[[str], RuntimeClient]


class SessionRuntime:
    def __init__(
        self,
        *,
        session_manager: SessionManager,
        client_factory: ClientFactory,
        handler_registrar=None,
    ) -> None:
        self._session_manager = session_manager
        self._client_factory = client_factory
        self._handler_registrar = handler_registrar
        self._clients: dict[str, RuntimeClient] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()

    @property
    def active_user_count(self) -> int:
        return len(self._clients)

    async def _user_lock(self, user_id: str) -> asyncio.Lock:
        if not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")
        async with self._locks_guard:
            return self._locks.setdefault(user_id, asyncio.Lock())

    async def connect_user(self, user_id: str) -> RuntimeClient:
        lock = await self._user_lock(user_id)
        async with lock:
            existing = self._clients.get(user_id)
            if existing is not None:
                return existing

            session_string = await self._session_manager.load_session(user_id)
            if not session_string:
                raise LookupError("no authorized Telegram session is stored for this user")

            client = self._client_factory(session_string)
            try:
                await client.connect()
                if not await client.is_user_authorized():
                    raise PermissionError("stored Telegram session is no longer authorized")
                if self._handler_registrar is not None:
                    await self._handler_registrar(client, user_id)
            except Exception:
                try:
                    await client.disconnect()
                except Exception:
                    pass
                raise

            self._clients[user_id] = client
            emit_monitor_event("session_reconnected")
            return client

    async def restore_saved_sessions(self) -> dict[str, int]:
        """Reconnect every previously authorized session without interactive login.

        A failure for one account is isolated and does not prevent other saved
        accounts from being restored. The returned object contains counts only.
        """
        list_user_ids = getattr(self._session_manager, "list_user_ids", None)
        if list_user_ids is None:
            raise RuntimeError("session manager does not support session restoration")
        user_ids = await list_user_ids()
        connected = 0
        failed = 0
        for user_id in user_ids:
            try:
                await self.connect_user(user_id)
                connected += 1
            except Exception:
                failed += 1
        return {"connected": connected, "failed": failed}

    async def reconnect_all(self) -> dict[str, int]:
        """Compatibility entry point for restoring every saved authorized account."""
        return await self.restore_saved_sessions()

    async def get_client(self, user_id: str) -> RuntimeClient | None:
        await self._user_lock(user_id)
        return self._clients.get(user_id)

    async def disconnect_user(self, user_id: str) -> None:
        lock = await self._user_lock(user_id)
        async with lock:
            client = self._clients.pop(user_id, None)
            if client is not None:
                await client.disconnect()
                emit_monitor_event("session_disconnected")

    async def revoke_user(self, user_id: str) -> None:
        lock = await self._user_lock(user_id)
        async with lock:
            client = self._clients.pop(user_id, None)
            try:
                if client is not None:
                    await client.disconnect()
            finally:
                await self._session_manager.revoke_session(user_id)


class TelethonSessionClientFactory:
    """Create clients from existing StringSessions; never starts an auth flow."""

    def __init__(self, *, api_id: int, api_hash: str) -> None:
        if api_id <= 0 or not api_hash or not api_hash.strip():
            raise ValueError("valid Telegram API credentials are required")
        self._api_id = api_id
        self._api_hash = api_hash

    def __call__(self, session_string: str) -> RuntimeClient:
        try:
            from telethon import TelegramClient
            from telethon.sessions import StringSession
        except ImportError as exc:
            raise RuntimeError("install KageCatch with the telegram extra") from exc

        return TelegramClient(
            StringSession(session_string),
            self._api_id,
            self._api_hash,
        )
