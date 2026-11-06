"""Telegram-native account authorization using a clickable tg:// login link.

The link is the official one-time Telegram login token normally embedded in a
QR code. KageCatch presents the URI as a link and never renders a QR image or
collects OTP/2FA credentials in the bot or Mini App.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Callable

from telethon.errors import SessionPasswordNeededError


@dataclass
class _PendingQrAuthorization:
    client: object
    qr_login: object
    login_url: str
    expires_at: float
    status: str = "pending"
    task: asyncio.Task | None = None


class TelegramQrAuthorizationFlow:
    def __init__(
        self,
        *,
        client_factory: Callable[[], object],
        session_manager,
        ttl_seconds: int = 30,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if not 15 <= ttl_seconds <= 120:
            raise ValueError("ttl_seconds must be between 15 and 120")
        if clock is None:
            import time
            clock = time.monotonic
        self._client_factory = client_factory
        self._session_manager = session_manager
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._pending: dict[str, _PendingQrAuthorization] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()

    async def _lock_for(self, user_id: str) -> asyncio.Lock:
        if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")
        async with self._locks_guard:
            return self._locks.setdefault(user_id, asyncio.Lock())

    async def start(self, *, user_id: str) -> dict:
        lock = await self._lock_for(user_id)
        async with lock:
            current = self._pending.get(user_id)
            if current is not None and current.status == "pending" and self._clock() < current.expires_at:
                return self._snapshot(current)
            if current is not None and current.task is not None and not current.task.done():
                current.task.cancel()
                await asyncio.gather(current.task, return_exceptions=True)
                try:
                    await current.client.disconnect()
                except Exception:
                    pass

            existing = await self._session_manager.load_session(user_id)
            if existing:
                return {"status": "already_authorized"}

            client = self._client_factory()
            try:
                await client.connect()
                qr_login = await client.qr_login()
                login_url = getattr(qr_login, "url", None)
                if not isinstance(login_url, str) or not login_url.startswith("tg://login?token="):
                    raise RuntimeError("Telegram did not return a valid login deep link")
            except BaseException:
                try:
                    await client.disconnect()
                except Exception:
                    pass
                raise

            pending = _PendingQrAuthorization(
                client=client,
                qr_login=qr_login,
                login_url=login_url,
                expires_at=self._clock() + self._ttl_seconds,
            )
            self._pending[user_id] = pending
            pending.task = asyncio.create_task(self._wait_for_confirmation(user_id, pending))
            return self._snapshot(pending)

    async def _wait_for_confirmation(self, user_id: str, pending: _PendingQrAuthorization) -> None:
        try:
            await pending.qr_login.wait(timeout=self._ttl_seconds)
            if not await pending.client.is_user_authorized():
                raise PermissionError("Telegram did not authorize this account")
            session_string = pending.client.session.save()
            if not session_string:
                raise RuntimeError("Telethon did not produce an authorized session")
            await self._session_manager.save_authorized_session(user_id, session_string)
            pending.status = "connected"
        except SessionPasswordNeededError:
            pending.status = "two_factor_required"
        except asyncio.TimeoutError:
            pending.status = "expired"
        except asyncio.CancelledError:
            pending.status = "cancelled"
            raise
        except Exception:
            pending.status = "failed"
        finally:
            try:
                await pending.client.disconnect()
            except Exception:
                pass

    async def get_status(self, *, user_id: str) -> dict:
        lock = await self._lock_for(user_id)
        async with lock:
            pending = self._pending.get(user_id)
            if pending is None:
                return {"status": "not_pending"}
            if pending.status == "pending" and self._clock() >= pending.expires_at:
                pending.status = "expired"
                if pending.task is not None and not pending.task.done():
                    pending.task.cancel()
                    await asyncio.gather(pending.task, return_exceptions=True)
                    try:
                        await pending.client.disconnect()
                    except Exception:
                        pass
            return self._snapshot(pending)

    async def cancel(self, *, user_id: str) -> None:
        lock = await self._lock_for(user_id)
        async with lock:
            pending = self._pending.get(user_id)
            if pending is None:
                return
            pending.status = "cancelled"
            if pending.task is not None and not pending.task.done():
                pending.task.cancel()
                await asyncio.gather(pending.task, return_exceptions=True)
                try:
                    await pending.client.disconnect()
                except Exception:
                    pass
            else:
                try:
                    await pending.client.disconnect()
                except Exception:
                    pass

    def _snapshot(self, pending: _PendingQrAuthorization) -> dict:
        result = {
            "status": pending.status,
            "expires_in": max(0, int(pending.expires_at - self._clock())),
        }
        if pending.status == "pending":
            result["login_url"] = pending.login_url
        return result
