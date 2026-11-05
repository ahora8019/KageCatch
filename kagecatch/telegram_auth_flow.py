"""Short-lived, per-user Telegram authorization state for a bot-driven flow.

The caller is responsible for accepting secrets only in a private, authenticated
chat, suppressing update/body logging, and deleting secret-bearing messages on a
best-effort basis. This module never persists phone codes or 2FA passwords.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Callable

from telethon.errors import SessionPasswordNeededError


@dataclass
class _PendingAuthorization:
    client: object
    phone: str
    phone_code_hash: str
    expires_at: float
    attempts: int = 0


class TelegramAuthorizationFlow:
    """Coordinates one temporary Telethon login attempt per KageCatch user."""

    def __init__(
        self,
        *,
        client_factory: Callable[[], object],
        session_manager,
        ttl_seconds: int = 300,
        max_attempts: int = 3,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if ttl_seconds < 30:
            raise ValueError("ttl_seconds must be at least 30")
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        self._client_factory = client_factory
        self._session_manager = session_manager
        self._ttl_seconds = ttl_seconds
        self._max_attempts = max_attempts
        if clock is None:
            import time
            clock = time.monotonic
        self._clock = clock
        self._pending: dict[str, _PendingAuthorization] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()

    async def _lock_for(self, user_id: str) -> asyncio.Lock:
        self._validate_user(user_id)
        async with self._locks_guard:
            return self._locks.setdefault(user_id, asyncio.Lock())

    async def start(self, *, user_id: str, phone: str) -> str:
        lock = await self._lock_for(user_id)
        async with lock:
            current = self._pending.get(user_id)
            if current is not None and self._clock() < current.expires_at:
                raise RuntimeError("an authorization attempt is already pending")
            if current is not None:
                await self._discard(user_id)

            normalized_phone = phone.strip() if isinstance(phone, str) else ""
            if not normalized_phone:
                raise ValueError("phone number is required")

            client = self._client_factory()
            try:
                await client.connect()
                sent_code = await client.send_code_request(normalized_phone)
                code_hash = getattr(sent_code, "phone_code_hash", None)
                if not code_hash:
                    raise RuntimeError("Telegram did not return a login challenge")
                self._pending[user_id] = _PendingAuthorization(
                    client=client,
                    phone=normalized_phone,
                    phone_code_hash=code_hash,
                    expires_at=self._clock() + self._ttl_seconds,
                )
            except BaseException:
                try:
                    await client.disconnect()
                except Exception:
                    pass
                raise
            return "code_sent"

    async def submit_code(self, *, user_id: str, code: str) -> str:
        lock = await self._lock_for(user_id)
        async with lock:
            pending = await self._get_pending(user_id)
            if not isinstance(code, str) or not code.strip():
                raise ValueError("Telegram login code is required")
            try:
                await pending.client.sign_in(
                    phone=pending.phone,
                    code=code.strip(),
                    phone_code_hash=pending.phone_code_hash,
                )
            except SessionPasswordNeededError:
                return "password_required"
            except Exception:
                await self._record_failed_attempt(user_id, pending)
                raise
            return await self._complete(user_id, pending)

    async def submit_password(self, *, user_id: str, password: str) -> str:
        lock = await self._lock_for(user_id)
        async with lock:
            pending = await self._get_pending(user_id)
            if not isinstance(password, str) or not password:
                raise ValueError("Telegram 2FA password is required")
            try:
                await pending.client.sign_in(password=password)
            except Exception:
                await self._record_failed_attempt(user_id, pending)
                raise
            return await self._complete(user_id, pending)

    async def cancel(self, *, user_id: str) -> None:
        lock = await self._lock_for(user_id)
        async with lock:
            await self._discard(user_id)

    async def _get_pending(self, user_id: str) -> _PendingAuthorization:
        pending = self._pending.get(user_id)
        if pending is None:
            raise LookupError("no pending Telegram authorization for this user")
        if self._clock() >= pending.expires_at:
            await self._discard(user_id)
            raise TimeoutError("Telegram authorization attempt expired")
        return pending

    async def _record_failed_attempt(
        self, user_id: str, pending: _PendingAuthorization
    ) -> None:
        pending.attempts += 1
        if pending.attempts >= self._max_attempts:
            await self._discard(user_id)

    async def _complete(
        self, user_id: str, pending: _PendingAuthorization
    ) -> str:
        try:
            if not await pending.client.is_user_authorized():
                raise PermissionError("Telegram did not authorize this account")
            session_string = pending.client.session.save()
            if not session_string:
                raise RuntimeError("Telethon did not produce a reusable session")
            await self._session_manager.save_authorized_session(
                user_id, session_string
            )
        finally:
            await self._discard(user_id)
        return "connected"

    async def _discard(self, user_id: str) -> None:
        pending = self._pending.pop(user_id, None)
        if pending is not None:
            try:
                await pending.client.disconnect()
            except Exception:
                pass

    @staticmethod
    def _validate_user(user_id: str) -> None:
        if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")
