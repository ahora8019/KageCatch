"""Authenticated Worker-to-Python bridge for sanitized Telegram commands.

The Worker signs the exact HTTP method, path, timestamp, nonce, and body hash.
A persistent SQLite nonce ledger rejects replayed requests across process restarts.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol


BRIDGE_PATH = "/internal/telegram-update"
_TIMESTAMP_HEADER = "x-kagecatch-timestamp"
_NONCE_HEADER = "x-kagecatch-nonce"
_SIGNATURE_HEADER = "x-kagecatch-signature"
_NONCE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_SIGNATURE_PATTERN = re.compile(r"^[a-f0-9]{64}$")


def canonical_request(
    method: str, path: str, timestamp: str, nonce: str, body: bytes
) -> bytes:
    """Return the versioned canonical bytes shared with the Cloudflare Worker."""
    body_hash = hashlib.sha256(body).hexdigest()
    value = "\n".join(
        ("v1", method.upper(), path, timestamp, nonce, body_hash)
    )
    return value.encode("utf-8")


class NonceStore(Protocol):
    def claim(self, nonce: str, now: int, ttl_seconds: int) -> bool: ...


class SQLiteNonceStore:
    """Persistent, atomic nonce ledger; use a private durable local data path."""

    def __init__(self, database_path: str | Path) -> None:
        self._path = Path(database_path)
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS bridge_nonces ("
                "nonce TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)"
            )
        if self._path.exists():
            try:
                self._path.chmod(0o600)
            except OSError:
                pass

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=5)
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def claim(self, nonce: str, now: int, ttl_seconds: int) -> bool:
        """Atomically claim a nonce once; expired ledger entries are pruned."""
        try:
            with self._connect() as connection:
                connection.execute(
                    "DELETE FROM bridge_nonces WHERE seen_at < ?",
                    (now - ttl_seconds,),
                )
                connection.execute(
                    "INSERT INTO bridge_nonces (nonce, seen_at) VALUES (?, ?)",
                    (nonce, now),
                )
            return True
        except sqlite3.IntegrityError:
            return False


@dataclass(frozen=True)
class BridgeResult:
    status_code: int
    payload: dict[str, Any]


class _ReplyCapture:
    def __init__(self) -> None:
        self.reply: dict[str, Any] | None = None

    async def send_message(self, chat_id: int, text: str) -> None:
        self.reply = {"chat_id": chat_id, "text": text}


class EnrollmentBridge:
    """Verify signed requests and dispatch only sanitized /connect or /cancel."""

    def __init__(
        self,
        enrollment_handler: Any,
        shared_secret: str,
        nonce_store: NonceStore,
        *,
        clock=time.time,
        max_clock_skew_seconds: int = 60,
        max_body_bytes: int = 64 * 1024,
    ) -> None:
        if not isinstance(shared_secret, str) or len(shared_secret) < 32:
            raise ValueError("shared_secret must contain at least 32 characters")
        if max_clock_skew_seconds < 1 or max_body_bytes < 1:
            raise ValueError("bridge limits must be positive")
        self._handler = enrollment_handler
        self._secret = shared_secret.encode("utf-8")
        self._nonce_store = nonce_store
        self._clock = clock
        self._max_clock_skew = max_clock_skew_seconds
        self._max_body_bytes = max_body_bytes

    async def handle(
        self,
        method: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
    ) -> BridgeResult:
        if method.upper() != "POST":
            return BridgeResult(405, {"ok": False, "error": "method_not_allowed"})
        if path != BRIDGE_PATH:
            return BridgeResult(404, {"ok": False, "error": "not_found"})
        if not isinstance(body, bytes):
            return BridgeResult(400, {"ok": False, "error": "invalid_body"})
        if len(body) > self._max_body_bytes:
            return BridgeResult(413, {"ok": False, "error": "payload_too_large"})

        normalized_headers = {key.lower(): value for key, value in headers.items()}
        timestamp = normalized_headers.get(_TIMESTAMP_HEADER, "")
        nonce = normalized_headers.get(_NONCE_HEADER, "")
        signature = normalized_headers.get(_SIGNATURE_HEADER, "")
        if (
            not timestamp.isascii()
            or not timestamp.isdigit()
            or not _NONCE_PATTERN.fullmatch(nonce)
            or not _SIGNATURE_PATTERN.fullmatch(signature)
        ):
            return BridgeResult(401, {"ok": False, "error": "unauthorized"})

        now = int(self._clock())
        request_time = int(timestamp)
        if abs(now - request_time) > self._max_clock_skew:
            return BridgeResult(401, {"ok": False, "error": "unauthorized"})

        expected = hmac.new(
            self._secret,
            canonical_request(method, path, timestamp, nonce, body),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return BridgeResult(401, {"ok": False, "error": "unauthorized"})

        try:
            claimed = self._nonce_store.claim(
                nonce, now, self._max_clock_skew * 2
            )
        except Exception:
            return BridgeResult(503, {"ok": False, "error": "replay_store_unavailable"})
        if not claimed:
            return BridgeResult(401, {"ok": False, "error": "unauthorized"})

        try:
            update = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return BridgeResult(400, {"ok": False, "error": "invalid_json"})
        if not isinstance(update, dict):
            return BridgeResult(400, {"ok": False, "error": "invalid_update"})

        message = update.get("message")
        text = message.get("text") if isinstance(message, dict) else None
        if text not in {"/connect", "/cancel"}:
            return BridgeResult(200, {"ok": True, "handled": False})

        capture = _ReplyCapture()
        try:
            handled = await self._handler.handle(update, messenger=capture)
        except Exception:
            return BridgeResult(500, {"ok": False, "error": "handler_failed"})
        payload: dict[str, Any] = {"ok": True, "handled": handled}
        if capture.reply is not None:
            payload["reply"] = capture.reply
        return BridgeResult(200, payload)
