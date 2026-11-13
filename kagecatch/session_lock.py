"""D1-backed lease lock for single-owner Telethon sessions."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)


class SessionLockError(RuntimeError):
    pass


class SessionLockUnavailable(SessionLockError):
    pass


@dataclass(frozen=True)
class Lease:
    session_id: str
    owner_id: str
    expires_at: int


class D1SessionLease:
    """Calls authenticated Worker endpoints; secrets are never logged.

    Worker endpoints must implement conditional D1 statements atomically:
    acquire: INSERT ... ON CONFLICT(session_id) DO UPDATE ... WHERE expires_at <= now OR locked_by = owner RETURNING ...
    renew/release: UPDATE/DELETE constrained by both session_id and locked_by.
    """

    def __init__(self, base_url: str, secret: str, *, lease_seconds: int = 300,
                 heartbeat_seconds: int = 60, client: httpx.AsyncClient | None = None,
                 clock=time.time, owner_id: str | None = None) -> None:
        if not base_url.startswith("https://"):
            raise ValueError("lease API must use HTTPS")
        if len(secret.encode()) < 32:
            raise ValueError("lease signing secret must be at least 32 bytes")
        if lease_seconds < 30 or heartbeat_seconds <= 0 or heartbeat_seconds >= lease_seconds / 2:
            raise ValueError("invalid lease/heartbeat interval")
        self.base_url = base_url.rstrip("/")
        self._secret = secret.encode()
        self.lease_seconds = lease_seconds
        self.heartbeat_seconds = heartbeat_seconds
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(10, connect=5), follow_redirects=False)
        self._owns_client = client is None
        self._clock = clock
        self.owner_id = owner_id or uuid.uuid4().hex
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", self.owner_id):
            raise ValueError("owner_id must be a unique opaque identifier")
        self._lease: Lease | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._lost = asyncio.Event()

    @property
    def held(self) -> bool:
        return self._lease is not None and not self._lost.is_set()

    async def acquire(self, session_id: str) -> bool:
        if not isinstance(session_id, str) or not session_id or len(session_id) > 128:
            raise ValueError("valid session_id is required")
        if self._lease is not None:
            raise SessionLockError("this lease instance already owns a session")
        data = await self._request("POST", "/internal/session-locks/acquire",
                                   {"session_id": session_id, "locked_by": self.owner_id,
                                    "lease_seconds": self.lease_seconds})
        if data.get("acquired") is not True:
            return False
        self._lease = Lease(session_id, self.owner_id, int(data["expires_at"]))
        self._lost.clear()
        self._heartbeat_task = asyncio.create_task(self._heartbeat(), name="kagecatch-session-lease")
        return True

    async def _heartbeat(self) -> None:
        try:
            while self._lease is not None:
                await asyncio.sleep(self.heartbeat_seconds)
                lease = self._lease
                if lease is None:
                    return
                try:
                    data = await self._request("POST", "/internal/session-locks/renew",
                                               {"session_id": lease.session_id, "locked_by": lease.owner_id,
                                                "lease_seconds": self.lease_seconds})
                    if data.get("renewed") is not True:
                        raise SessionLockUnavailable("lease ownership lost")
                    self._lease = Lease(lease.session_id, lease.owner_id, int(data["expires_at"]))
                except Exception as exc:
                    self._lost.set()
                    logger.critical("session lease heartbeat failed; session must disconnect (%s)", type(exc).__name__)
                    return
        except asyncio.CancelledError:
            raise

    async def assert_held(self) -> None:
        if not self.held:
            raise SessionLockUnavailable("session lease is not held")

    async def release(self) -> None:
        lease, self._lease = self._lease, None
        task, self._heartbeat_task = self._heartbeat_task, None
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if lease is not None:
            try:
                await self._request("POST", "/internal/session-locks/release",
                                    {"session_id": lease.session_id, "locked_by": lease.owner_id})
            except Exception as exc:
                logger.error("session lease release failed (%s); it will expire automatically", type(exc).__name__)
        if self._owns_client:
            await self._client.aclose()

    async def _request(self, method: str, path: str, payload: dict) -> dict:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode()
        timestamp = str(int(self._clock()))
        nonce = uuid.uuid4().hex
        digest = hashlib.sha256(body).hexdigest()
        signing = f"{timestamp}\n{nonce}\n{method}\n{path}\n{digest}".encode()
        signature = hmac.new(self._secret, signing, hashlib.sha256).hexdigest()
        try:
            response = await self._client.request(method, self.base_url + path, content=body, headers={
                "content-type": "application/json", "X-KageCatch-Timestamp": timestamp,
                "X-KageCatch-Nonce": nonce, "X-KageCatch-Signature": signature,
            })
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, dict):
                raise SessionLockUnavailable("invalid lease API response")
            return result
        except (httpx.HTTPError, ValueError) as exc:
            raise SessionLockUnavailable("lease API unavailable") from exc
