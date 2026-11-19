"""Atomic, persistent quota and deduplication admission for Catch Engine.

Each admitted dispatch consumes one quota slot. A failed or ambiguous send keeps
its reservation: automatically retrying an uncertain Telegram request could
send the same catch command twice.
"""
from __future__ import annotations

import asyncio
import math
import os
import re
import sqlite3
import time
from pathlib import Path
from typing import Callable, Literal

AdmissionDecision = Literal["admitted", "duplicate", "quota_blocked"]

_USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SOURCE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class SQLiteCatchAdmissionStore:
    """Single-host SQLite admission gate with a rolling per-user/source quota.

    The unique dedupe key is retained indefinitely. Only quota counting is
    time-windowed, so an old Telegram update cannot become catchable again just
    because its quota window expired. Use a durable local volume for the DB.
    """

    def __init__(
        self,
        database_path: str | os.PathLike[str],
        *,
        max_attempts: int,
        window_seconds: float,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int):
            raise ValueError("max_attempts must be a positive integer")
        if not 1 <= max_attempts <= 1_000_000:
            raise ValueError("max_attempts must be between 1 and 1000000")
        if (
            isinstance(window_seconds, bool)
            or not isinstance(window_seconds, (int, float))
            or not math.isfinite(float(window_seconds))
            or not 0 < float(window_seconds) <= 31_536_000
        ):
            raise ValueError("window_seconds must be greater than 0 and at most one year")
        if not callable(clock):
            raise ValueError("clock must be callable")

        raw_path = os.fspath(database_path)
        if not raw_path or raw_path == ":memory:":
            raise ValueError("database_path must point to a durable SQLite file")
        self._path = Path(raw_path).expanduser().resolve()
        self._max_attempts = max_attempts
        self._window_seconds = float(window_seconds)
        self._clock = clock

        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            os.chmod(self._path.parent, 0o700)
        except OSError:
            pass
        self._initialize()
        try:
            os.chmod(self._path, 0o600)
        except OSError:
            pass

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self._path,
            timeout=10,
            isolation_level=None,
        )
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    def _initialize(self) -> None:
        connection = self._connect()
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS catch_admission_attempts (
                    dedupe_key TEXT PRIMARY KEY NOT NULL,
                    user_id TEXT NOT NULL,
                    source TEXT NOT NULL,
                    attempted_at REAL NOT NULL CHECK (attempted_at >= 0)
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_catch_admission_quota
                ON catch_admission_attempts(user_id, source, attempted_at)
                """
            )
        finally:
            connection.close()

    async def reserve(
        self,
        *,
        user_id: str,
        source: str,
        dedupe_key: str,
    ) -> AdmissionDecision:
        self._validate_identity(user_id, source, dedupe_key)
        now = self._clock()
        if (
            isinstance(now, bool)
            or not isinstance(now, (int, float))
            or not math.isfinite(float(now))
            or float(now) < 0
        ):
            raise RuntimeError("catch admission clock returned an invalid timestamp")
        return await asyncio.to_thread(
            self._reserve_sync,
            user_id,
            source,
            dedupe_key,
            float(now),
        )

    @staticmethod
    def _validate_identity(user_id: str, source: str, dedupe_key: str) -> None:
        if not isinstance(user_id, str) or not _USER_ID_RE.fullmatch(user_id):
            raise ValueError("user_id must be a canonical identifier")
        if not isinstance(source, str) or not _SOURCE_RE.fullmatch(source):
            raise ValueError("source must be a canonical source identifier")
        if (
            not isinstance(dedupe_key, str)
            or not dedupe_key
            or len(dedupe_key) > 256
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in dedupe_key)
        ):
            raise ValueError("dedupe_key must be a bounded, non-empty text value")

    def _reserve_sync(
        self,
        user_id: str,
        source: str,
        dedupe_key: str,
        now: float,
    ) -> AdmissionDecision:
        connection = self._connect()
        try:
            # Serialize the duplicate check, quota count, and insert. This also
            # protects against concurrent Core workers using the same SQLite DB.
            connection.execute("BEGIN IMMEDIATE")

            duplicate = connection.execute(
                "SELECT 1 FROM catch_admission_attempts WHERE dedupe_key = ?",
                (dedupe_key,),
            ).fetchone()
            if duplicate is not None:
                connection.rollback()
                return "duplicate"

            cutoff = now - self._window_seconds
            count = connection.execute(
                """
                SELECT COUNT(*)
                FROM catch_admission_attempts
                WHERE user_id = ? AND source = ? AND attempted_at > ?
                """,
                (user_id, source, cutoff),
            ).fetchone()[0]
            if count >= self._max_attempts:
                connection.rollback()
                return "quota_blocked"

            connection.execute(
                """
                INSERT INTO catch_admission_attempts
                    (dedupe_key, user_id, source, attempted_at)
                VALUES (?, ?, ?, ?)
                """,
                (dedupe_key, user_id, source, now),
            )
            connection.commit()
            return "admitted"
        except sqlite3.IntegrityError:
            connection.rollback()
            # A unique-key collision is a duplicate, never permission to send.
            return "duplicate"
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def close(self) -> None:
        """Compatibility hook; each operation opens and closes its own connection."""
        return None
