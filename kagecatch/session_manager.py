"""Encrypted storage boundary for user-authorized Telethon StringSessions.

The encryption key must be supplied by the deployment secret manager. Never
commit it, log it, or send it to the control bot.
"""
from __future__ import annotations

import json
import math
import re
from typing import Protocol

from cryptography.fernet import Fernet, InvalidToken


_USER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_PHONE_PATTERN = re.compile(r"^\+[1-9]\d{7,14}$")
_PENDING_REQUIRED_FIELDS = {"version", "phone", "phone_code_hash", "session_string", "expires_at"}
_PENDING_ALLOWED_FIELDS = _PENDING_REQUIRED_FIELDS | {"attempts", "session_authorized"}
_MAX_SESSION_STRING_LENGTH = 8192


class SessionStore(Protocol):
    async def put(self, user_id: str, encrypted_session: bytes) -> None: ...
    async def get(self, user_id: str) -> bytes | None: ...
    async def delete(self, user_id: str) -> None: ...
    async def put_pending(self, user_id: str, encrypted_payload: bytes) -> None: ...
    async def get_pending(self, user_id: str) -> bytes | None: ...
    async def delete_pending(self, user_id: str) -> None: ...


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
        if (
            not isinstance(session_string, str)
            or not session_string.strip()
            or len(session_string) > _MAX_SESSION_STRING_LENGTH
        ):
            raise ValueError("session_string must be a bounded, non-empty string")
        encrypted = self._fernet.encrypt(session_string.encode("utf-8"))
        await self._store.put(user_id, encrypted)

    async def save_session(self, user_id: str, session_string: str) -> None:
        """Encrypt and persist an authorized Telethon StringSession."""
        await self.save_authorized_session(user_id, session_string)

    async def get_session(self, user_id: str) -> str | None:
        """Load and decrypt a previously persisted Telethon StringSession."""
        return await self.load_session(user_id)

    async def load_session(self, user_id: str) -> str | None:
        self._validate_user(user_id)
        encrypted = await self._store.get(user_id)
        if encrypted is None:
            return None
        try:
            return self._fernet.decrypt(encrypted).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError) as exc:
            raise ValueError("stored session cannot be decrypted") from exc

    async def save_pending_authorization(self, user_id: str, payload: dict) -> None:
        self._validate_user(user_id)
        self._validate_pending_payload(payload)
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")
        encrypted = self._fernet.encrypt(encoded)
        await self._store.put_pending(user_id, encrypted)

    async def load_pending_authorization(self, user_id: str) -> dict | None:
        self._validate_user(user_id)
        encrypted = await self._store.get_pending(user_id)
        if encrypted is None:
            return None
        try:
            payload = json.loads(self._fernet.decrypt(encrypted).decode("utf-8"))
        except Exception as exc:
            raise ValueError("stored authorization challenge cannot be decrypted") from exc
        self._validate_pending_payload(payload)
        return payload

    async def delete_pending_authorization(self, user_id: str) -> None:
        self._validate_user(user_id)
        await self._store.delete_pending(user_id)

    async def list_user_ids(self) -> list[str]:
        """Return IDs of users with stored authorized sessions, never session material."""
        list_users = getattr(self._store, "list_users", None)
        if list_users is None:
            raise RuntimeError("session store does not support listing saved sessions")
        users = await list_users()
        if not isinstance(users, list) or any(not isinstance(user, str) for user in users):
            raise RuntimeError("session store returned an invalid user list")
        for user in users:
            self._validate_user(user)
        return list(dict.fromkeys(users))

    async def revoke_session(self, user_id: str) -> None:
        self._validate_user(user_id)
        await self._store.delete(user_id)

    @staticmethod
    def _validate_user(user_id: str) -> None:
        if not isinstance(user_id, str) or not _USER_ID_PATTERN.fullmatch(user_id):
            raise ValueError("user_id must be a canonical ASCII identifier")

    @staticmethod
    def _validate_pending_payload(payload: dict) -> None:
        if not isinstance(payload, dict):
            raise ValueError("pending authorization payload must be an object")
        keys = set(payload)
        if not _PENDING_REQUIRED_FIELDS.issubset(keys) or not keys.issubset(_PENDING_ALLOWED_FIELDS):
            raise ValueError("pending authorization payload contains missing or unsupported fields")

        version = payload["version"]
        if isinstance(version, bool) or version != 1:
            raise ValueError("unsupported pending authorization payload version")

        phone = payload["phone"]
        if not isinstance(phone, str) or not _PHONE_PATTERN.fullmatch(phone):
            raise ValueError("pending authorization phone must use E.164 format")

        phone_code_hash = payload["phone_code_hash"]
        if (
            not isinstance(phone_code_hash, str)
            or not phone_code_hash.strip()
            or len(phone_code_hash) > 512
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in phone_code_hash)
        ):
            raise ValueError("pending authorization challenge hash is invalid")

        session_string = payload["session_string"]
        if (
            not isinstance(session_string, str)
            or not session_string.strip()
            or len(session_string) > _MAX_SESSION_STRING_LENGTH
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in session_string)
        ):
            raise ValueError("pending authorization session string is invalid")

        expires_at = payload["expires_at"]
        if (
            isinstance(expires_at, bool)
            or not isinstance(expires_at, (int, float))
            or not math.isfinite(float(expires_at))
            or float(expires_at) < 0
        ):
            raise ValueError("pending authorization expiry is invalid")

        attempts = payload.get("attempts", 0)
        if isinstance(attempts, bool) or not isinstance(attempts, int) or not 0 <= attempts <= 100:
            raise ValueError("pending authorization attempt count is invalid")

        session_authorized = payload.get("session_authorized", False)
        if not isinstance(session_authorized, bool):
            raise ValueError("pending authorization confirmation flag is invalid")
