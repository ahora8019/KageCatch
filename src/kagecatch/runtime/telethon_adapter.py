"""Telethon adapter backed by encrypted, pre-enrolled session strings.

This adapter intentionally does not implement phone-code or 2FA login flows.
Accounts must be enrolled through a separate, explicitly authorized workflow.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .session_store import SessionStore


class NoStoredSessionError(RuntimeError):
    """Raised when an account has not completed the separate enrollment flow."""


class SessionAuthorizationError(RuntimeError):
    """Raised when a stored Telegram session is no longer authorized."""


class TelethonSessionClient:
    """Adapt a Telethon client to KageCatch's small async session protocol."""

    def __init__(self, account_id: str, client: Any, session_store: SessionStore) -> None:
        self._account_id = account_id
        self._client = client
        self._session_store = session_store
        self._authorized = False

    async def connect(self) -> None:
        if self.is_connected():
            return
        await self._client.connect()
        try:
            if not await self._client.is_user_authorized():
                raise SessionAuthorizationError(
                    "Telegram session is not authorized; re-enrollment is required"
                )
            self._persist_session()
            self._authorized = True
        except BaseException:
            self._authorized = False
            try:
                await self._client.disconnect()
            except Exception:
                pass
            raise

    async def disconnect(self) -> None:
        try:
            if self._authorized:
                self._persist_session()
        finally:
            self._authorized = False
            await self._client.disconnect()

    def is_connected(self) -> bool:
        return self._authorized and self._client.is_connected()

    def _persist_session(self) -> None:
        session = self._client.session.save()
        if not isinstance(session, str) or not session:
            raise RuntimeError("Telethon returned an empty session string")
        self._session_store.save(self._account_id, session)


class TelethonSessionFactory:
    """Build isolated Telethon clients from each account's encrypted session."""

    def __init__(
        self,
        *,
        api_id: int,
        api_hash: str,
        session_store: SessionStore,
        client_builder: Callable[[str, int, str], Any] | None = None,
    ) -> None:
        if not isinstance(api_id, int) or api_id <= 0:
            raise ValueError("api_id must be a positive integer")
        if not isinstance(api_hash, str) or not api_hash.strip():
            raise ValueError("api_hash must not be empty")
        self._api_id = api_id
        self._api_hash = api_hash
        self._session_store = session_store
        self._client_builder = client_builder or self._build_telethon_client

    @staticmethod
    def _build_telethon_client(session: str, api_id: int, api_hash: str) -> Any:
        try:
            from telethon import TelegramClient
            from telethon.sessions import StringSession
        except ImportError as exc:
            raise RuntimeError(
                "Telethon is required; install KageCatch with the telegram extra"
            ) from exc
        return TelegramClient(StringSession(session), api_id, api_hash)

    def __call__(self, account_id: str) -> TelethonSessionClient:
        session = self._session_store.load(account_id)
        if not session:
            raise NoStoredSessionError(
                "account has no enrolled Telegram session"
            )
        client = self._client_builder(session, self._api_id, self._api_hash)
        return TelethonSessionClient(account_id, client, self._session_store)
