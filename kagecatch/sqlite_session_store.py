"""SQLite-backed storage for already-encrypted Telegram sessions.

Only ciphertext is stored here. Encryption/decryption belongs to SessionManager.
This local store is suitable for a single Python execution host, not a shared
multi-instance deployment.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from pathlib import Path


class SQLiteSessionStore:
    def __init__(self, database_path: str | os.PathLike[str]) -> None:
        self._path = Path(database_path).expanduser().resolve()
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            os.chmod(self._path.parent, 0o700)
        except OSError:
            pass
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS telegram_sessions (
                        user_id TEXT PRIMARY KEY,
                        encrypted_session BLOB NOT NULL,
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS telegram_auth_challenges (
                        user_id TEXT PRIMARY KEY,
                        encrypted_payload BLOB NOT NULL,
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
        if self._path.exists():
            try:
                os.chmod(self._path, 0o600)
            except OSError:
                pass

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    async def put(self, user_id: str, encrypted_session: bytes) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    """
                    INSERT INTO telegram_sessions(user_id, encrypted_session, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id) DO UPDATE SET
                        encrypted_session=excluded.encrypted_session,
                        updated_at=CURRENT_TIMESTAMP
                    """,
                    (user_id, sqlite3.Binary(encrypted_session)),
                )

    async def get(self, user_id: str) -> bytes | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT encrypted_session FROM telegram_sessions WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return bytes(row[0]) if row is not None else None

    async def list_users(self) -> list[str]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT user_id FROM telegram_sessions ORDER BY user_id"
            ).fetchall()
        return [str(row[0]) for row in rows]

    async def delete(self, user_id: str) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "DELETE FROM telegram_sessions WHERE user_id = ?",
                    (user_id,),
                )

    async def put_pending(self, user_id: str, encrypted_payload: bytes) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    """
                    INSERT INTO telegram_auth_challenges(user_id, encrypted_payload, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id) DO UPDATE SET
                        encrypted_payload=excluded.encrypted_payload,
                        updated_at=CURRENT_TIMESTAMP
                    """,
                    (user_id, sqlite3.Binary(encrypted_payload)),
                )

    async def get_pending(self, user_id: str) -> bytes | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT encrypted_payload FROM telegram_auth_challenges WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return bytes(row[0]) if row is not None else None

    async def delete_pending(self, user_id: str) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "DELETE FROM telegram_auth_challenges WHERE user_id = ?",
                    (user_id,),
                )

    async def close(self) -> None:
        """Compatibility hook; connections are short-lived and closed per operation."""
        return None
