"""Restart-safe, short-lived per-user Telegram authorization flow.

Only an encrypted, temporary Telethon StringSession and challenge metadata are
persisted by SessionManager. Login codes and 2FA passwords are never stored.
"""
from __future__ import annotations

import asyncio
import re
import time
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
        client_factory: Callable[..., object],
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
        self._clock = clock or time.time
        self._pending: dict[str, _PendingAuthorization] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()

    def _new_client(self, session_string: str = ""):
        try:
            return self._client_factory(session_string)
        except TypeError:
            # Backward-compatible for injected test factories that take no args.
            return self._client_factory()

    async def _persist(self, user_id: str, pending: _PendingAuthorization) -> None:
        session_string = pending.client.session.save()
        if not isinstance(session_string, str) or not session_string:
            raise RuntimeError("Telethon did not produce a resumable session")
        await self._session_manager.save_pending_authorization(
            user_id,
            {
                "version": 1,
                "phone": pending.phone,
                "phone_code_hash": pending.phone_code_hash,
                "session_string": session_string,
                "expires_at": pending.expires_at,
                "attempts": pending.attempts,
            },
        )

    async def _restore(self, user_id: str) -> _PendingAuthorization | None:
        payload = await self._session_manager.load_pending_authorization(user_id)
        if payload is None:
            return None
        try:
            if payload.get("version") != 1:
                raise ValueError
            phone = payload["phone"]
            phone_hash = payload["phone_code_hash"]
            session_string = payload["session_string"]
            expires_at = float(payload["expires_at"])
            attempts = int(payload.get("attempts", 0))
            if (
                not isinstance(phone, str)
                or not re.fullmatch(r"\+[1-9]\d{7,14}", phone)
                or not isinstance(phone_hash, str)
                or not phone_hash
                or not isinstance(session_string, str)
                or not session_string
                or attempts < 0
            ):
                raise ValueError
        except (KeyError, TypeError, ValueError) as exc:
            await self._session_manager.delete_pending_authorization(user_id)
            raise ValueError("stored authorization challenge is invalid") from exc
        if self._clock() >= expires_at or attempts >= self._max_attempts:
            await self._session_manager.delete_pending_authorization(user_id)
            return None
        client = self._new_client(session_string)
        try:
            await client.connect()
        except Exception:
            try:
                await client.disconnect()
            except Exception:
                pass
            raise
        pending = _PendingAuthorization(client, phone, phone_hash, expires_at, attempts)
        self._pending[user_id] = pending
        return pending

    async def _lock_for(self, user_id: str) -> asyncio.Lock:
        self._validate_user(user_id)
        async with self._locks_guard:
            return self._locks.setdefault(user_id, asyncio.Lock())

    async def start(self, *, user_id: str, phone: str) -> str:
        lock = await self._lock_for(user_id)
        async with lock:
            current = self._pending.get(user_id)
            if current is None:
                current = await self._restore(user_id)
            if current is not None:
                raise RuntimeError("an authorization attempt is already pending")

            normalized_phone = phone.strip() if isinstance(phone, str) else ""
            if not re.fullmatch(r"\+[1-9]\d{7,14}", normalized_phone):
                raise ValueError("phone number must use E.164 format")
            if await self._session_manager.load_session(user_id):
                raise RuntimeError("already_authorized")

            client = self._new_client()
            try:
                await client.connect()
                sent_code = await client.send_code_request(normalized_phone)
                code_hash = getattr(sent_code, "phone_code_hash", None)
                if not code_hash:
                    raise RuntimeError("Telegram did not return a login challenge")
                pending = _PendingAuthorization(
                    client=client,
                    phone=normalized_phone,
                    phone_code_hash=code_hash,
                    expires_at=self._clock() + self._ttl_seconds,
                )
                await self._persist(user_id, pending)
                self._pending[user_id] = pending
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
            if not isinstance(code, str) or not re.fullmatch(r"\d{4,8}", code.strip()):
                raise ValueError("Telegram login code must contain 4 to 8 digits")
            try:
                await pending.client.sign_in(
                    phone=pending.phone,
                    code=code.strip(),
                    phone_code_hash=pending.phone_code_hash,
                )
            except SessionPasswordNeededError:
                await self._persist(user_id, pending)
                return "password_required"
            except Exception:
                await self._record_failed_attempt(user_id, pending)
                raise
            return await self._complete(user_id, pending)

    async def submit_password(self, *, user_id: str, password: str) -> str:
        lock = await self._lock_for(user_id)
        async with lock:
            pending = await self._get_pending(user_id)
            if not isinstance(password, str) or not password or len(password) > 256:
                raise ValueError("Telegram 2FA password is required")
            try:
                await pending.client.sign_in(password=password)
            except Exception:
                await self._record_failed_attempt(user_id, pending)
                raise
            return await self._complete(user_id, pending)

    async def get_status(self, *, user_id: str) -> dict:
        lock = await self._lock_for(user_id)
        async with lock:
            pending = self._pending.get(user_id)
            if pending is None:
                pending = await self._restore(user_id)
            if pending is None:
                return {"status": "not_pending"}
            if self._clock() >= pending.expires_at:
                await self._discard(user_id)
                return {"status": "expired"}
            return {
                "status": "pending",
                "expires_in": max(0, int(pending.expires_at - self._clock())),
                "attempts_remaining": max(0, self._max_attempts - pending.attempts),
            }

    async def cancel(self, *, user_id: str) -> None:
        lock = await self._lock_for(user_id)
        async with lock:
            await self._discard(user_id)

    async def _get_pending(self, user_id: str) -> _PendingAuthorization:
        pending = self._pending.get(user_id)
        if pending is None:
            pending = await self._restore(user_id)
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
        else:
            await self._persist(user_id, pending)

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
        try:
            await self._session_manager.delete_pending_authorization(user_id)
        finally:
            if pending is not None:
                try:
                    await pending.client.disconnect()
                except Exception:
                    pass

    @staticmethod
    def _validate_user(user_id: str) -> None:
        if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")
