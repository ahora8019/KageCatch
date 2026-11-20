"""Durable D1-backed atomic Catch admission through the signed Control Worker API."""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import time
import uuid
from urllib.parse import urlsplit

import httpx


class D1CatchAdmissionStore:
    """Atomically reserve a spawn against a durable dedupe key and rolling quota.

    A reservation is never released after dispatch: an ambiguous Telegram send
    must not be retried automatically because the destination may have accepted it.
    """

    PATH = "/internal/job-queue"
    _DECISIONS = {"admitted", "duplicate", "quota_blocked"}

    def __init__(self, base_url: str, secret: str, *, max_attempts: int = 5,
                 window_seconds: float = 3600, client: httpx.AsyncClient | None = None,
                 clock=time.time, nonce_factory=uuid.uuid4) -> None:
        parsed = urlsplit(base_url) if isinstance(base_url, str) else None
        loopback = bool(parsed and parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
                        and parsed.port and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment)
        if not parsed or (parsed.scheme != "https" and not loopback):
            raise ValueError("catch admission URL must use HTTPS except for loopback development")
        if not isinstance(secret, str) or len(secret.encode()) < 32:
            raise ValueError("catch admission secret must contain at least 32 bytes")
        self._base_url = base_url.rstrip("/")
        self._secret = secret.encode()
        self._max_attempts = self._validate_max_attempts(max_attempts)
        self._window_seconds = self._validate_window(window_seconds)
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(10, connect=5), follow_redirects=False)
        self._owns_client = client is None
        self._clock, self._nonce_factory = clock, nonce_factory

    async def reserve(self, *, user_id: str, source: str, dedupe_key: str) -> str:
        if not isinstance(user_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", user_id):
            raise ValueError("user_id must be a canonical identifier")
        if not isinstance(source, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", source):
            raise ValueError("source must be a canonical source identifier")
        if (not isinstance(dedupe_key, str) or not dedupe_key or len(dedupe_key) > 256
                or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in dedupe_key)):
            raise ValueError("dedupe_key must be a bounded, non-empty text value")
        payload = {
            "action": "admit_catch", "user_id": user_id, "source": source,
            "dedupe_key": dedupe_key, "max_attempts": self._max_attempts,
            "window_seconds": self._window_seconds,
        }
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()
        timestamp = str(int(self._clock()))
        nonce_value = self._nonce_factory()
        nonce = nonce_value.hex if hasattr(nonce_value, "hex") else str(nonce_value)
        nonce = nonce.replace("-", "")
        if not re.fullmatch(r"[A-Za-z0-9_]{16,128}", nonce):
            raise ValueError("nonce factory returned an invalid nonce")
        signing_text = f"{timestamp}\n{nonce}\nPOST\n{self.PATH}\n{hashlib.sha256(body).hexdigest()}"
        signature = hmac.new(self._secret, signing_text.encode(), hashlib.sha256).hexdigest()
        response = await self._client.post(self._base_url + self.PATH, content=body, headers={
            "content-type": "application/json", "X-KageCatch-Timestamp": timestamp,
            "X-KageCatch-Nonce": nonce, "X-KageCatch-Signature": signature,
        })
        response.raise_for_status()
        data = response.json()
        decision = data.get("status") if isinstance(data, dict) else None
        if decision not in self._DECISIONS:
            raise RuntimeError("D1 catch admission returned an invalid decision")
        return decision

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    @staticmethod
    def _validate_max_attempts(value: int) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 1_000_000:
            raise ValueError("max_attempts must be between 1 and 1000000")
        return value

    @staticmethod
    def _validate_window(value: float) -> float:
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(float(value)) or not 0 < float(value) <= 31_536_000):
            raise ValueError("window_seconds must be greater than 0 and at most one year")
        return float(value)
