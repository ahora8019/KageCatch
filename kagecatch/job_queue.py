"""SQLite-backed durable job queue with typed claims and fenced leases.

The database must live on persistent local storage. SQLite/WAL is not a
cross-region queue and must not be placed on an object-store mount.
"""
from __future__ import annotations

import asyncio
from contextlib import closing
from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
import time
from typing import Any, Callable, Iterable
from uuid import uuid4


class IdempotencyConflictError(ValueError):
    """An idempotency key was reused for a different logical job."""


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
    """Persistent priority queue with idempotency, typed subscriptions and leases."""

    def __init__(self, path: str, *, clock: Callable[[], float] = time.time) -> None:
        if not isinstance(path, str) or not path.strip():
            raise ValueError("a database path is required")
        if not callable(clock):
            raise ValueError("clock must be callable")
        self.path = path
        self._clock = clock
        self._lock = asyncio.Lock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
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
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_catch_jobs_claim "
                "ON catch_jobs(status, run_after, priority DESC, created_at)"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_catch_jobs_type_claim "
                "ON catch_jobs(job_type, status, run_after, priority DESC, created_at)"
            )

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=10000")
        return db

    async def enqueue(
        self,
        job_type: str,
        payload: dict[str, Any],
        *,
        priority: int = 0,
        idempotency_key: str | None = None,
        max_attempts: int = 3,
        run_after: float | None = None,
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
            not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > 256
        ):
            raise ValueError("invalid idempotency_key")
        if run_after is not None and (
            isinstance(run_after, bool) or not isinstance(run_after, (int, float))
        ):
            raise ValueError("run_after must be a timestamp")
        try:
            payload_json = json.dumps(
                payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("payload must be JSON serializable") from exc

        now = float(self._clock())
        scheduled_at = now if run_after is None else float(run_after)
        job_id = uuid4().hex
        async with self._lock:
            with closing(self._connect()) as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    if idempotency_key is None:
                        db.execute("""
                            INSERT INTO catch_jobs
                            (job_id, job_type, payload_json, priority, status, max_attempts,
                             idempotency_key, run_after, created_at, updated_at)
                            VALUES (?, ?, ?, ?, 'queued', ?, NULL, ?, ?, ?)
                        """, (job_id, job_type.strip(), payload_json, priority,
                              max_attempts, scheduled_at, now, now))
                        row = db.execute(
                            "SELECT * FROM catch_jobs WHERE job_id=?", (job_id,)
                        ).fetchone()
                    else:
                        db.execute("""
                            INSERT OR IGNORE INTO catch_jobs
                            (job_id, job_type, payload_json, priority, status, max_attempts,
                             idempotency_key, run_after, created_at, updated_at)
                            VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
                        """, (job_id, job_type.strip(), payload_json, priority,
                              max_attempts, idempotency_key, scheduled_at, now, now))
                        row = db.execute(
                            "SELECT * FROM catch_jobs WHERE idempotency_key=?",
                            (idempotency_key,),
                        ).fetchone()
                        if row is None:
                            raise RuntimeError("idempotent enqueue did not produce a row")
                        if row["job_type"] != job_type.strip() or row["payload_json"] != payload_json:
                            raise IdempotencyConflictError(
                                "idempotency_key already belongs to a different job"
                            )
                    db.execute("COMMIT")
                except BaseException:
                    db.execute("ROLLBACK")
                    raise
        return self._to_job(row)

    async def claim_next(
        self,
        worker_id: str,
        *,
        lease_seconds: float = 60,
        job_types: Iterable[str] | None = None,
    ) -> Job | None:
        if not isinstance(worker_id, str) or not worker_id.strip() or len(worker_id) > 128:
            raise ValueError("worker_id must contain 1 to 128 characters")
        if isinstance(lease_seconds, bool) or not isinstance(lease_seconds, (int, float)) or not 1 <= lease_seconds <= 3600:
            raise ValueError("lease_seconds must be between 1 and 3600")
        types: tuple[str, ...] | None = None
        if job_types is not None:
            if isinstance(job_types, (str, bytes)):
                raise ValueError("job_types must be a collection of job type names")
            types = tuple(dict.fromkeys(job_types))
            if not types or any(
                not isinstance(item, str) or not item.strip() or len(item) > 128
                for item in types
            ):
                raise ValueError("job_types must contain valid job type names")

        now = float(self._clock())
        async with self._lock:
            with closing(self._connect()) as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    where_types = ""
                    params: list[Any] = [now]
                    if types is not None:
                        where_types = f" AND job_type IN ({','.join('?' for _ in types)})"
                        params.extend(types)
                    row = db.execute(
                        "SELECT * FROM catch_jobs WHERE status='queued' AND run_after<=?"
                        + where_types
                        + " ORDER BY priority DESC, created_at ASC LIMIT 1",
                        tuple(params),
                    ).fetchone()
                    if row is None:
                        db.execute("COMMIT")
                        return None
                    changed = db.execute("""
                        UPDATE catch_jobs
                        SET status='running', attempts=attempts+1,
                            lease_generation=lease_generation+1,
                            worker_id=?, lease_until=?, updated_at=?
                        WHERE job_id=? AND status='queued'
                    """, (worker_id, now + float(lease_seconds), now, row["job_id"]))
                    if changed.rowcount != 1:
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
            "UPDATE catch_jobs SET status='completed', worker_id=NULL, "
            "lease_until=NULL, updated_at=? WHERE job_id=? AND status='running' "
            "AND worker_id=? AND lease_generation=? AND lease_until>?",
        )

    async def dead_letter(self, job_id: str, worker_id: str, *, lease_generation: int) -> None:
        """Permanently quarantine an unprocessable job without retrying it."""
        await self._owned_transition(
            job_id, worker_id, lease_generation,
            "UPDATE catch_jobs SET status='dead', worker_id=NULL, "
            "lease_until=NULL, updated_at=? WHERE job_id=? AND status='running' "
            "AND worker_id=? AND lease_generation=? AND lease_until>?",
        )

    async def fail(
        self,
        job_id: str,
        worker_id: str,
        *,
        lease_generation: int,
        retry_delay: float = 0,
    ) -> str:
        if isinstance(retry_delay, bool) or not isinstance(retry_delay, (int, float)) or retry_delay < 0:
            raise ValueError("retry_delay must be non-negative")
        now = float(self._clock())
        async with self._lock:
            with closing(self._connect()) as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    row = db.execute(
                        "SELECT attempts, max_attempts FROM catch_jobs "
                        "WHERE job_id=? AND status='running' AND worker_id=? "
                        "AND lease_generation=? AND lease_until>?",
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
        return await self._count("status IN ('queued','running')")

    async def dead_letter_count(self) -> int:
        return await self._count("status='dead'")

    async def _count(self, where: str) -> int:
        async with self._lock:
            with closing(self._connect()) as db:
                row = db.execute(
                    f"SELECT COUNT(*) AS count FROM catch_jobs WHERE {where}"
                ).fetchone()
                return int(row["count"])

    async def close(self) -> None:
        """Connections are scoped to individual operations; retained for API symmetry."""

    async def _owned_transition(
        self, job_id: str, worker_id: str, lease_generation: int, sql: str
    ) -> None:
        now = float(self._clock())
        async with self._lock:
            with closing(self._connect()) as db:
                changed = db.execute(sql, (now, job_id, worker_id, lease_generation, now))
                if changed.rowcount != 1:
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
