"""Small, durable SQLite job queue for the Functional Core pipeline."""
from __future__ import annotations

import asyncio
from contextlib import closing
import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4


@dataclass(frozen=True, slots=True)
class Job:
    job_id: str
    job_type: str
    payload: dict[str, Any]
    priority: int
    status: str
    attempts: int
    max_attempts: int
    worker_id: str | None
    lease_until: float | None
    lease_generation: int


class SQLiteJobQueue:
    """Persistent, priority-aware queue with idempotency and worker leases."""

    def __init__(self, path: str, *, clock: Callable[[], float] = time.time) -> None:
        if not isinstance(path, str) or not path.strip():
            raise ValueError("a database path is required")
        self.path = path
        self._clock = clock
        self._lock = asyncio.Lock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.execute("""
                CREATE TABLE IF NOT EXISTS catch_jobs (
                    job_id TEXT PRIMARY KEY,
                    job_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    priority INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','dead')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL,
                    idempotency_key TEXT UNIQUE,
                    worker_id TEXT,
                    lease_until REAL,
                    lease_generation INTEGER NOT NULL DEFAULT 0,
                    run_after REAL NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
            """)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(catch_jobs)")}
            if "lease_generation" not in columns:
                db.execute("ALTER TABLE catch_jobs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0")
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_catch_jobs_claim "
                "ON catch_jobs(status, run_after, priority DESC, created_at)"
            )

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=10000")
        return db

    async def enqueue(
        self, job_type: str, payload: dict[str, Any], *, priority: int = 0,
        idempotency_key: str | None = None, max_attempts: int = 3,
    ) -> Job:
        if not isinstance(job_type, str) or not job_type.strip() or len(job_type) > 128:
            raise ValueError("job_type must contain 1 to 128 characters")
        if not isinstance(payload, dict):
            raise ValueError("payload must be a JSON object")
        if isinstance(priority, bool) or not isinstance(priority, int):
            raise ValueError("priority must be an integer")
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or not 1 <= max_attempts <= 20:
            raise ValueError("max_attempts must be between 1 and 20")
        if idempotency_key is not None and (
            not isinstance(idempotency_key, str) or not idempotency_key or len(idempotency_key) > 256
        ):
            raise ValueError("invalid idempotency_key")
        try:
            payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ValueError("payload must be JSON serializable") from exc
        now, job_id = float(self._clock()), uuid4().hex
        async with self._lock:
            with closing(self._connect()) as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    db.execute("""
                        INSERT OR IGNORE INTO catch_jobs
                        (job_id, job_type, payload_json, priority, status, max_attempts,
                         idempotency_key, run_after, created_at, updated_at)
                        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
                    """, (job_id, job_type.strip(), payload_json, priority, max_attempts,
                          idempotency_key, now, now, now))
                    row = db.execute(
                        "SELECT * FROM catch_jobs WHERE idempotency_key = ?"
                        if idempotency_key is not None else
                        "SELECT * FROM catch_jobs WHERE job_id = ?",
                        (idempotency_key if idempotency_key is not None else job_id,),
                    ).fetchone()
                    db.execute("COMMIT")
                except BaseException:
                    db.execute("ROLLBACK")
                    raise
        return self._to_job(row)

    async def claim_next(self, worker_id: str, *, lease_seconds: float = 60) -> Job | None:
        if not isinstance(worker_id, str) or not worker_id.strip() or len(worker_id) > 128:
            raise ValueError("worker_id must contain 1 to 128 characters")
        if isinstance(lease_seconds, bool) or not isinstance(lease_seconds, (int, float)) or not 1 <= lease_seconds <= 3600:
            raise ValueError("lease_seconds must be between 1 and 3600")
        now = float(self._clock())
        async with self._lock:
            with closing(self._connect()) as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    row = db.execute("""
                        SELECT * FROM catch_jobs
                        WHERE status = 'queued' AND run_after <= ?
                        ORDER BY priority DESC, created_at ASC LIMIT 1
                    """, (now,)).fetchone()
                    if row is None:
                        db.execute("COMMIT")
                        return None
                    updated = db.execute("""
                        UPDATE catch_jobs
                        SET status='running', attempts=attempts+1,
                            lease_generation=lease_generation+1,
                            worker_id=?, lease_until=?, updated_at=?
                        WHERE job_id=? AND status='queued'
                    """, (worker_id, now + float(lease_seconds), now, row["job_id"]))
                    if updated.rowcount != 1:
                        db.execute("COMMIT")
                        return None
                    claimed = db.execute(
                        "SELECT * FROM catch_jobs WHERE job_id=?", (row["job_id"],)
                    ).fetchone()
                    db.execute("COMMIT")
                except BaseException:
                    db.execute("ROLLBACK")
                    raise
        return self._to_job(claimed)

    async def complete(self, job_id: str, worker_id: str, *, lease_generation: int) -> None:
        await self._owned_transition(
            job_id, worker_id, lease_generation,
            "UPDATE catch_jobs SET status='completed', worker_id=NULL, lease_until=NULL, updated_at=? "
            "WHERE job_id=? AND status='running' AND worker_id=? AND lease_generation=? AND lease_until>?",
        )

    async def fail(self, job_id: str, worker_id: str, *, lease_generation: int, retry_delay: float = 0) -> str:
        if isinstance(retry_delay, bool) or not isinstance(retry_delay, (int, float)) or retry_delay < 0:
            raise ValueError("retry_delay must be non-negative")
        now = float(self._clock())
        async with self._lock:
            with closing(self._connect()) as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    row = db.execute(
                        "SELECT attempts, max_attempts FROM catch_jobs "
                        "WHERE job_id=? AND status='running' AND worker_id=? AND lease_generation=? AND lease_until>?",
                        (job_id, worker_id, lease_generation, now),
                    ).fetchone()
                    if row is None:
                        raise PermissionError("job is not leased by this worker")
                    status = "dead" if row["attempts"] >= row["max_attempts"] else "queued"
                    db.execute(
                        "UPDATE catch_jobs SET status=?, worker_id=NULL, lease_until=NULL, "
                        "run_after=?, updated_at=? WHERE job_id=?",
                        (status, now + float(retry_delay), now, job_id),
                    )
                    db.execute("COMMIT")
                    return status
                except BaseException:
                    db.execute("ROLLBACK")
                    raise

    async def recover_expired(self) -> int:
        now = float(self._clock())
        async with self._lock:
            with closing(self._connect()) as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    result = db.execute("""
                        UPDATE catch_jobs
                        SET status=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'queued' END,
                            worker_id=NULL, lease_until=NULL, run_after=?, updated_at=?
                        WHERE status='running' AND lease_until<=?
                    """, (now, now, now))
                    count = result.rowcount
                    db.execute("COMMIT")
                    return count
                except BaseException:
                    db.execute("ROLLBACK")
                    raise

    async def pending_count(self) -> int:
        async with self._lock:
            with closing(self._connect()) as db:
                row = db.execute(
                    "SELECT COUNT(*) AS count FROM catch_jobs WHERE status IN ('queued','running')"
                ).fetchone()
                return int(row["count"])

    async def dead_letter_count(self) -> int:
        async with self._lock:
            with closing(self._connect()) as db:
                row = db.execute(
                    "SELECT COUNT(*) AS count FROM catch_jobs WHERE status='dead'"
                ).fetchone()
                return int(row["count"])

    async def close(self) -> None:
        """Connections are scoped to individual operations."""

    async def _owned_transition(self, job_id: str, worker_id: str, lease_generation: int, sql: str) -> None:
        now = float(self._clock())
        async with self._lock:
            with closing(self._connect()) as db:
                result = db.execute(sql, (now, job_id, worker_id, lease_generation, now))
                if result.rowcount != 1:
                    raise PermissionError("job is not leased by this worker")

    @staticmethod
    def _to_job(row: sqlite3.Row) -> Job:
        if row is None:
            raise RuntimeError("job queue row disappeared")
        return Job(
            job_id=row["job_id"], job_type=row["job_type"],
            payload=json.loads(row["payload_json"]), priority=int(row["priority"]),
            status=row["status"], attempts=int(row["attempts"]),
            max_attempts=int(row["max_attempts"]), worker_id=row["worker_id"],
            lease_until=row["lease_until"], lease_generation=int(row["lease_generation"]),
        )
