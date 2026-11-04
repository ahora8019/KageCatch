"""Encrypted storage boundary for user-authorized Telethon StringSessions.

The encryption key must be supplied by the deployment secret manager. Never
commit it, log it, or send it to the control bot.
"""
from __future__ import annotations

from typing import Protocol

from cryptography.fernet import Fernet, InvalidToken


class SessionStore(Protocol):
    async def put(self, user_id: str, encrypted_session: bytes) -> None: ...
    async def get(self, user_id: str) -> bytes | None: ...
    async def delete(self, user_id: str) -> None: ...


class SessionManager:
    def __init__(self, *, fernet_key: str | bytes, store: SessionStore) -> None:
        try:
            self._fernet = Fernet(
                fernet_key.encode("ascii") if isinstance(fernet_key, str) else fernet_key
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("fernet_key must be a valid Fernet key") from exc
        self._store = store

    async def save_authorized_session(self, user_id: str, session_string: str) -> None:
        self._validate_user(user_id)
        if not session_string or not session_string.strip():
            raise ValueError("session_string is required")
        encrypted = self._fernet.encrypt(session_string.encode("utf-8"))
        await self._store.put(user_id, encrypted)

    async def load_session(self, user_id: str) -> str | None:
        self._validate_user(user_id)
        encrypted = await self._store.get(user_id)
        if encrypted is None:
            return None
        try:
            return self._fernet.decrypt(encrypted).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError) as exc:
            raise ValueError("stored session cannot be decrypted") from exc

    async def revoke_session(self, user_id: str) -> None:
        self._validate_user(user_id)
        await self._store.delete(user_id)

    @staticmethod
    def _validate_user(user_id: str) -> None:
        if not user_id or len(user_id) > 128:
            raise ValueError("valid user_id is required")
