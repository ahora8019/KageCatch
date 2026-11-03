"""Encrypted, per-account persistence for Telegram session strings."""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Protocol

from cryptography.fernet import Fernet, InvalidToken


class SessionStore(Protocol):
    """Storage contract consumed by Telegram session adapters."""

    def load(self, account_id: str) -> str | None: ...

    def save(self, account_id: str, session: str) -> None: ...


class SessionStoreError(RuntimeError):
    """Raised when encrypted session data cannot be safely read or written."""


class EncryptedFileSessionStore:
    """Persist encrypted session strings with restrictive local file permissions.

    The Fernet key must be supplied from a secret manager/environment variable.
    It is deliberately never generated, written, or rotated by this class.
    """

    def __init__(self, directory: str | Path, key: str | bytes) -> None:
        try:
            self._cipher = Fernet(key.encode("ascii") if isinstance(key, str) else key)
        except (TypeError, ValueError) as exc:
            raise ValueError("key must be a valid Fernet key") from exc

        self._directory = Path(directory).expanduser()
        if self._directory.is_symlink():
            raise SessionStoreError("session directory must not be a symlink")
        self._directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not self._directory.is_dir():
            raise SessionStoreError("session path is not a directory")
        if os.name == "posix":
            self._directory.chmod(0o700)

    @staticmethod
    def _account_key(account_id: str) -> str:
        if not isinstance(account_id, str) or not account_id.strip():
            raise ValueError("account_id must not be empty")
        return hashlib.sha256(account_id.strip().encode("utf-8")).hexdigest()

    def _path_for(self, account_id: str) -> Path:
        return self._directory / f"{self._account_key(account_id)}.session"

    def load(self, account_id: str) -> str | None:
        path = self._path_for(account_id)
        if path.is_symlink():
            raise SessionStoreError("session entry is not a regular file")
        if not path.exists():
            return None
        if not path.is_file():
            raise SessionStoreError("session entry is not a regular file")
        try:
            encrypted = path.read_bytes()
            return self._cipher.decrypt(encrypted).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError, OSError) as exc:
            raise SessionStoreError("could not decrypt stored session") from exc

    def save(self, account_id: str, session: str) -> None:
        if not isinstance(session, str) or not session:
            raise ValueError("session must not be empty")
        destination = self._path_for(account_id)
        encrypted = self._cipher.encrypt(session.encode("utf-8"))
        temporary_path: str | None = None
        try:
            descriptor, temporary_path = tempfile.mkstemp(
                prefix=".session-", suffix=".tmp", dir=self._directory
            )
            if os.name == "posix":
                os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(encrypted)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, destination)
            temporary_path = None
            if os.name == "posix":
                destination.chmod(0o600)
        except OSError as exc:
            raise SessionStoreError("could not persist encrypted session") from exc
        finally:
            if temporary_path is not None:
                try:
                    os.unlink(temporary_path)
                except FileNotFoundError:
                    pass
