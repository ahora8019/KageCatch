"""SQLite persistence for per-owner Telegram safety state.

This store contains operational lock/cooldown metadata only; it never stores
Telegram session strings, API credentials, message contents, or user payloads.
It is a single-host store. Multi-instance coordination requires a shared
transactional store and is deliberately not implied by this implementation.
"""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any


class SQLiteSafetyStateStore:
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
                    CREATE TABLE IF NOT EXISTS telegram_safety_state (
                        owner_id TEXT PRIMARY KEY,
                        state_json TEXT NOT NULL,
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
        try:
            os.chmod(self._path, 0o600)
        except OSError:
            pass

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    @staticmethod
    def _validate_owner(owner_id: str) -> None:
        if not isinstance(owner_id, str) or not owner_id or len(owner_id) > 128:
            raise ValueError("valid owner_id is required")

    def load(self, owner_id: str) -> dict[str, Any] | None:
        self._validate_owner(owner_id)
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT state_json FROM telegram_safety_state WHERE owner_id = ?",
                (owner_id,),
            ).fetchone()
        if row is None:
            return None
        try:
            value = json.loads(row[0])
        except (TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError("stored Telegram safety state is corrupt") from exc
        if not isinstance(value, dict):
            raise RuntimeError("stored Telegram safety state is invalid")
        return value

    def save(self, owner_id: str, state: dict[str, Any]) -> None:
        self._validate_owner(owner_id)
        if not isinstance(state, dict):
            raise ValueError("safety state must be an object")
        encoded = json.dumps(
            state, separators=(",", ":"), sort_keys=True, allow_nan=False
        )
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    """
                    INSERT INTO telegram_safety_state(owner_id, state_json, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(owner_id) DO UPDATE SET
                        state_json=excluded.state_json,
                        updated_at=CURRENT_TIMESTAMP
                    """,
                    (owner_id, encoded),
                )

    def delete(self, owner_id: str) -> None:
        self._validate_owner(owner_id)
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "DELETE FROM telegram_safety_state WHERE owner_id = ?",
                    (owner_id,),
                )

    async def close(self) -> None:
        """Compatibility hook; each operation owns and closes its connection."""
        return None
