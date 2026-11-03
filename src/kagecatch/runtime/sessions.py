"""Async lifecycle management for isolated per-account Telegram sessions.

The manager owns client lifecycle only. Concrete Telegram adapters (for example,
Telethon) are injected through a factory so this layer remains testable without
network access or real account credentials.
"""

import asyncio
from collections.abc import Callable
from typing import Protocol


class SessionClient(Protocol):
    """Minimal async interface required from a Telegram session adapter."""

    async def connect(self) -> None: ...

    async def disconnect(self) -> None: ...

    def is_connected(self) -> bool: ...


SessionFactory = Callable[[str], SessionClient]


class SessionManager:
    """Manage at most one live client for each account identifier."""

    def __init__(self, factory: SessionFactory) -> None:
        if not callable(factory):
            raise TypeError("factory must be callable")
        self._factory = factory
        self._sessions: dict[str, SessionClient] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    @staticmethod
    def _validate_account_id(account_id: str) -> str:
        if not isinstance(account_id, str) or not account_id.strip():
            raise ValueError("account_id must not be empty")
        return account_id.strip()

    def _lock_for(self, account_id: str) -> asyncio.Lock:
        lock = self._locks.get(account_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[account_id] = lock
        return lock

    def is_running(self, account_id: str) -> bool:
        """Return whether the requested account currently has a live session."""
        normalized = self._validate_account_id(account_id)
        session = self._sessions.get(normalized)
        return session is not None and session.is_connected()

    async def start(self, account_id: str) -> bool:
        """Connect one account; return False when its session is already live."""
        normalized = self._validate_account_id(account_id)
        async with self._lock_for(normalized):
            current = self._sessions.get(normalized)
            if current is not None and current.is_connected():
                return False
            if current is not None:
                try:
                    await current.disconnect()
                except Exception as exc:
                    raise RuntimeError(
                        "could not clean up the previous session"
                    ) from exc
                self._sessions.pop(normalized, None)

            session = self._factory(normalized)
            try:
                await session.connect()
            except BaseException:
                try:
                    await session.disconnect()
                except Exception:
                    pass
                raise

            if not session.is_connected():
                try:
                    await session.disconnect()
                finally:
                    raise RuntimeError("session adapter did not become connected")

            self._sessions[normalized] = session
            return True

    async def stop(self, account_id: str) -> bool:
        """Disconnect and remove only the requested account's session."""
        normalized = self._validate_account_id(account_id)
        async with self._lock_for(normalized):
            session = self._sessions.get(normalized)
            if session is None:
                return False
            await session.disconnect()
            self._sessions.pop(normalized, None)
            return True
