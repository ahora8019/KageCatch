"""Authenticated Worker-to-Python bridge for sanitized Telegram commands.

The Worker signs the exact HTTP method, path, timestamp, nonce, and body hash.
A persistent SQLite nonce ledger rejects replayed requests across process restarts.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol

from .bridge_auth import BridgeAuthError, verify_bridge_request


BRIDGE_PATH = "/internal/telegram-update"


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
    async def reserve(self, nonce: str, *, expires_at: int, now: int) -> bool: ...


class SQLiteNonceStore:
    """Persistent atomic nonce ledger for one Python Core host."""

    def __init__(self, database_path: str | Path) -> None:
        self._path = Path(database_path)
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        connection = self._connect()
        try:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS bridge_nonces ("
                "nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)"
            )
            connection.commit()
        finally:
            connection.close()
        if self._path.exists():
            try:
                self._path.chmod(0o600)
            except OSError:
                pass

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=5)
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    async def reserve(self, nonce: str, *, expires_at: int, now: int) -> bool:
        """Atomically reserve a nonce once and prune expired reservations."""
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    "DELETE FROM bridge_nonces WHERE expires_at < ?", (now,)
                )
                connection.execute(
                    "INSERT INTO bridge_nonces (nonce, expires_at) VALUES (?, ?)",
                    (nonce, expires_at),
                )
            return True
        except sqlite3.IntegrityError:
            return False
        finally:
            connection.close()


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
        if not isinstance(shared_secret, str) or len(shared_secret.encode("utf-8")) < 32:
            raise ValueError("shared_secret must contain at least 32 bytes")
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
        auth_headers = {
            "X-KageCatch-Timestamp": normalized_headers.get("x-kagecatch-timestamp", ""),
            "X-KageCatch-Nonce": normalized_headers.get("x-kagecatch-nonce", ""),
            "X-KageCatch-Signature": normalized_headers.get("x-kagecatch-signature", ""),
        }
        try:
            await verify_bridge_request(
                secret=self._secret,
                method=method.upper(),
                path=path,
                body=body,
                headers=auth_headers,
                replay_guard=self._nonce_store,
                now=int(self._clock()),
                max_clock_skew_seconds=self._max_clock_skew,
            )
        except BridgeAuthError:
            return BridgeResult(401, {"ok": False, "error": "unauthorized"})
        except Exception:
            return BridgeResult(503, {"ok": False, "error": "replay_store_unavailable"})

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
