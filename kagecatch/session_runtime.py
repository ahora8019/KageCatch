"""Lifecycle manager for explicitly authorized, per-user Telethon sessions.

A configured distributed lease is acquired before a Telethon client is created
or connected. Loss of that lease closes the client immediately.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable, Protocol

from .session_manager import SessionManager
from .monitoring import emit_monitor_event
from .telegram_safety_guard import GuardMode, TelegramSafetyGuard


class RuntimeClient(Protocol):
    async def connect(self) -> None: ...
    async def is_user_authorized(self) -> bool: ...
    async def disconnect(self) -> None: ...


class SessionLease(Protocol):
    async def acquire(self, session_id: str) -> bool: ...
    async def assert_held(self) -> None: ...
    def start_heartbeat(self) -> None: ...
    async def wait_lost(self) -> None: ...
    async def release(self) -> None: ...


ClientFactory = Callable[[str], RuntimeClient]
LeaseFactory = Callable[[str], SessionLease]
SafetyGuardFactory = Callable[[], TelegramSafetyGuard]


class SessionAlreadyLockedError(RuntimeError):
    """Another Core instance currently owns this Telegram session."""


class SessionAuthorizationLostError(PermissionError):
    """Telegram no longer considers the stored owner session authorized."""


class SessionSafetyLockedError(PermissionError):
    """Safety lock requires explicit owner reauthorization or security review."""


class SessionRuntime:
    def __init__(
        self,
        *,
        session_manager: SessionManager,
        client_factory: ClientFactory,
        handler_registrar=None,
        lease_factory: LeaseFactory | None = None,
        safety_guard_factory: SafetyGuardFactory | None = None,
        safety_state_store=None,
        safety_wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._session_manager = session_manager
        self._client_factory = client_factory
        self._handler_registrar = handler_registrar
        self._lease_factory = lease_factory
        self._safety_guard_factory = safety_guard_factory
        self._safety_state_store = safety_state_store
        self._safety_wall_clock = safety_wall_clock
        self._safety_guards: dict[str, TelegramSafetyGuard] = {}
        self._clients: dict[str, RuntimeClient] = {}
        self._leases: dict[str, SessionLease] = {}
        self._lease_watchers: dict[str, asyncio.Task] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()
        self._closing = False

    @property
    def active_user_count(self) -> int:
        return len(self._clients)

    def safety_guard_for(self, user_id: str) -> TelegramSafetyGuard:
        """Return the stable per-owner guard to inject into outbound adapters."""
        if not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")
        guard = self._safety_guards.get(user_id)
        if guard is None:
            if self._safety_guard_factory is not None:
                guard = self._safety_guard_factory()
            else:
                guard = TelegramSafetyGuard(
                    clock=time.monotonic,
                    wall_clock=self._safety_wall_clock,
                    state_store=self._safety_state_store,
                    owner_id=user_id if self._safety_state_store is not None else None,
                )
            self._safety_guards[user_id] = guard
        return guard

    async def _user_lock(self, user_id: str) -> asyncio.Lock:
        if not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")
        async with self._locks_guard:
            return self._locks.setdefault(user_id, asyncio.Lock())

    async def _await_with_lease(self, operation, lease: SessionLease | None):
        """Abort an in-flight startup operation as soon as lease ownership is lost."""
        if lease is None:
            return await operation
        operation_task = asyncio.create_task(operation)
        lost_task = asyncio.create_task(lease.wait_lost())
        try:
            done, _ = await asyncio.wait(
                {operation_task, lost_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if lost_task in done:
                operation_task.cancel()
                await asyncio.gather(operation_task, return_exceptions=True)
                raise RuntimeError("distributed session lease was lost during session startup")
            return await operation_task
        finally:
            if not operation_task.done():
                operation_task.cancel()
            if not lost_task.done():
                lost_task.cancel()
            await asyncio.gather(operation_task, lost_task, return_exceptions=True)

    async def connect_user(self, user_id: str) -> RuntimeClient:
        lock = await self._user_lock(user_id)
        async with lock:
            if self._closing:
                raise RuntimeError("session runtime is shutting down")
            guard = self.safety_guard_for(user_id)
            if guard.mode in {
                GuardMode.SESSION_LOCKED,
                GuardMode.SECURITY_LOCKED,
                GuardMode.MANUAL_LOCKED,
            }:
                existing_locked_client = self._clients.get(user_id)
                if existing_locked_client is not None:
                    await self._discard_owned_client(user_id, existing_locked_client)
                raise SessionSafetyLockedError(
                    "Telegram session is safety-locked; explicit reauthorization and review are required"
                )
            existing = self._clients.get(user_id)
            if existing is not None:
                lease = self._leases.get(user_id)
                if lease is None:
                    return existing
                try:
                    await lease.assert_held()
                    return existing
                except Exception:
                    await self._discard_owned_client(user_id, existing)

            session_string = await self._session_manager.load_session(user_id)
            if not session_string:
                raise LookupError("no authorized Telegram session is stored for this user")

            lease: SessionLease | None = None
            client: RuntimeClient | None = None
            try:
                if self._lease_factory is not None:
                    lease = self._lease_factory(user_id)
                    if not await lease.acquire(user_id):
                        raise SessionAlreadyLockedError(
                            "this Telegram session is already active on another Core instance"
                        )
                    await lease.assert_held()
                client = self._client_factory(session_string)
                await self._await_with_lease(client.connect(), lease)
                if lease is not None:
                    await lease.assert_held()
                if not await self._await_with_lease(client.is_user_authorized(), lease):
                    raise SessionAuthorizationLostError("stored Telegram session is no longer authorized")
                if self._handler_registrar is not None:
                    await self._await_with_lease(self._handler_registrar(client, user_id), lease)
                if lease is not None:
                    await lease.assert_held()
                    lease.start_heartbeat()
                if self._closing:
                    raise RuntimeError("session runtime is shutting down")
            except BaseException as exc:
                if not isinstance(exc, asyncio.CancelledError):
                    event = guard.observe_error(exc)
                    if event.category == "session_revoked":
                        emit_monitor_event("session_revoked", level=logging.ERROR)
                    elif event.category == "security_lock":
                        emit_monitor_event("telegram_security_lock", level=logging.CRITICAL)
                    elif event.category == "rate_limit":
                        emit_monitor_event("flood_wait", level=logging.WARNING)
                if client is not None:
                    try:
                        await client.disconnect()
                    except Exception:
                        pass
                if lease is not None:
                    try:
                        await lease.release()
                    except Exception:
                        logging.getLogger("kagecatch.core").exception(
                            "Failed to release session lease after connection failure"
                        )
                raise

            self._clients[user_id] = client
            if lease is not None:
                self._leases[user_id] = lease
                self._lease_watchers[user_id] = asyncio.create_task(
                    self._watch_lease(user_id, client, lease),
                    name=f"kagecatch-lease-watch-{user_id}",
                )
            emit_monitor_event("session_reconnected")
            return client

    async def _watch_lease(
        self, user_id: str, client: RuntimeClient, lease: SessionLease
    ) -> None:
        try:
            await lease.wait_lost()
            lock = await self._user_lock(user_id)
            async with lock:
                if self._clients.get(user_id) is client and self._leases.get(user_id) is lease:
                    await self._discard_owned_client(user_id, client)
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.getLogger("kagecatch.core").exception(
                "Session lease watcher failed; forcing client disconnect"
            )
            lock = await self._user_lock(user_id)
            async with lock:
                if self._clients.get(user_id) is client and self._leases.get(user_id) is lease:
                    await self._discard_owned_client(user_id, client)

    async def _discard_owned_client(self, user_id: str, client: RuntimeClient) -> None:
        if self._clients.get(user_id) is not client:
            return
        self._clients.pop(user_id, None)
        lease = self._leases.pop(user_id, None)
        watcher = self._lease_watchers.pop(user_id, None)
        if watcher is not None and watcher is not asyncio.current_task():
            watcher.cancel()
            try:
                await watcher
            except asyncio.CancelledError:
                pass
        try:
            await client.disconnect()
            emit_monitor_event("session_disconnected")
        finally:
            if lease is not None:
                await lease.release()

    async def restore_saved_sessions(self) -> dict[str, int]:
        """Reconnect every previously authorized session without interactive login."""
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
        lock = await self._user_lock(user_id)
        async with lock:
            if self.safety_guard_for(user_id).mode in {
                GuardMode.SESSION_LOCKED,
                GuardMode.SECURITY_LOCKED,
                GuardMode.MANUAL_LOCKED,
            }:
                existing_locked_client = self._clients.get(user_id)
                if existing_locked_client is not None:
                    await self._discard_owned_client(user_id, existing_locked_client)
                return None
            return self._clients.get(user_id)

    async def disconnect_user(self, user_id: str) -> None:
        lock = await self._user_lock(user_id)
        async with lock:
            client = self._clients.get(user_id)
            if client is not None:
                await self._discard_owned_client(user_id, client)

    async def close(self) -> None:
        """Stop new connections, await in-flight startups, and release all leases."""
        self._closing = True
        for user_id in list(self._locks):
            try:
                lock = await self._user_lock(user_id)
                async with lock:
                    client = self._clients.get(user_id)
                    if client is not None:
                        await self._discard_owned_client(user_id, client)
            except Exception:
                logging.getLogger("kagecatch.core").exception(
                    "Failed to cleanly close a Telegram session during shutdown"
                )

    async def revoke_user(self, user_id: str) -> None:
        lock = await self._user_lock(user_id)
        async with lock:
            client = self._clients.get(user_id)
            try:
                if client is not None:
                    await self._discard_owned_client(user_id, client)
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
