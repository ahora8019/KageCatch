"""Authentication primitives for the Worker-to-Python-Core bridge.

The bridge authenticates the exact HTTP method, path, timestamp, nonce, and
body bytes. Production deployments must use a shared secret from a secret
manager and a durable, shared replay guard when multiple Core instances run.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Protocol


_TIMESTAMP_HEADER = "X-KageCatch-Timestamp"
_NONCE_HEADER = "X-KageCatch-Nonce"
_SIGNATURE_HEADER = "X-KageCatch-Signature"
_NONCE_PATTERN = re.compile(r"^[0-9a-f]{32,128}$")
_SIGNATURE_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class BridgeAuthError(Exception):
    """Raised when a bridge request is not authentic or is a replay."""


class ReplayGuard(Protocol):
    async def reserve(self, nonce: str, *, expires_at: int, now: int) -> bool:
        """Atomically reserve a nonce; return False if it was already reserved."""
        ...


class InMemoryReplayGuard:
    """Single-process replay guard for development and tests only."""

    def __init__(self) -> None:
        import asyncio

        self._lock = asyncio.Lock()
        self._nonces: dict[str, int] = {}

    async def reserve(self, nonce: str, *, expires_at: int, now: int) -> bool:
        async with self._lock:
            expired = [key for key, expiry in self._nonces.items() if expiry < now]
            for key in expired:
                del self._nonces[key]
            if nonce in self._nonces:
                return False
            self._nonces[nonce] = expires_at
            return True


def _validate_secret(secret: bytes) -> None:
    if not isinstance(secret, bytes) or len(secret) < 32:
        raise ValueError("bridge secret must contain at least 32 bytes")


def _canonical_message(
    *, method: str, path: str, timestamp: str, nonce: str, body: bytes
) -> bytes:
    if not isinstance(method, str) or not method or method != method.upper():
        raise ValueError("method must be a non-empty uppercase HTTP method")
    if not isinstance(path, str) or not path.startswith("/") or "?" in path or "#" in path:
        raise ValueError("path must be an absolute path without query or fragment")
    if not isinstance(body, bytes):
        raise ValueError("body must be raw bytes")
    body_hash = hashlib.sha256(body).hexdigest()
    return "\n".join((method, path, timestamp, nonce, body_hash)).encode("utf-8")


def sign_bridge_request(
    *,
    secret: bytes,
    method: str,
    path: str,
    body: bytes,
    timestamp: int,
    nonce: str,
) -> dict[str, str]:
    """Build the three authentication headers for an exact request payload."""
    _validate_secret(secret)
    if isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp <= 0:
        raise ValueError("timestamp must be a positive Unix timestamp")
    if not isinstance(nonce, str) or not _NONCE_PATTERN.fullmatch(nonce):
        raise ValueError("nonce must be 32-128 lowercase hexadecimal characters")
    timestamp_text = str(timestamp)
    message = _canonical_message(
        method=method, path=path, timestamp=timestamp_text, nonce=nonce, body=body
    )
    signature = hmac.new(secret, message, hashlib.sha256).hexdigest()
    return {
        _TIMESTAMP_HEADER: timestamp_text,
        _NONCE_HEADER: nonce,
        _SIGNATURE_HEADER: signature,
    }


async def verify_bridge_request(
    *,
    secret: bytes,
    method: str,
    path: str,
    body: bytes,
    headers: dict[str, str],
    replay_guard: ReplayGuard,
    now: int | None = None,
    max_clock_skew_seconds: int = 300,
) -> None:
    """Verify signature, clock window, and one-time nonce; fail closed."""
    _validate_secret(secret)
    if isinstance(max_clock_skew_seconds, bool) or not isinstance(max_clock_skew_seconds, int) or max_clock_skew_seconds < 1:
        raise ValueError("max_clock_skew_seconds must be a positive integer")
    current_time = int(time.time()) if now is None else now
    if isinstance(current_time, bool) or not isinstance(current_time, int) or current_time <= 0:
        raise ValueError("now must be a positive Unix timestamp")
    if not isinstance(headers, dict):
        raise BridgeAuthError("malformed authentication headers")

    timestamp_text = headers.get(_TIMESTAMP_HEADER)
    nonce = headers.get(_NONCE_HEADER)
    signature = headers.get(_SIGNATURE_HEADER)
    if (
        not isinstance(timestamp_text, str)
        or not timestamp_text.isascii()
        or not timestamp_text.isdigit()
        or (len(timestamp_text) > 1 and timestamp_text.startswith("0"))
        or not isinstance(nonce, str)
        or not _NONCE_PATTERN.fullmatch(nonce)
        or not isinstance(signature, str)
        or not _SIGNATURE_PATTERN.fullmatch(signature)
    ):
        raise BridgeAuthError("malformed authentication headers")

    timestamp = int(timestamp_text)
    if abs(current_time - timestamp) > max_clock_skew_seconds:
        raise BridgeAuthError("timestamp outside allowed clock window")

    try:
        message = _canonical_message(
            method=method,
            path=path,
            timestamp=timestamp_text,
            nonce=nonce,
            body=body,
        )
    except (TypeError, ValueError) as exc:
        raise BridgeAuthError("malformed request") from exc

    expected = hmac.new(secret, message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise BridgeAuthError("invalid request signature")

    reserved = await replay_guard.reserve(
        nonce,
        expires_at=timestamp + max_clock_skew_seconds,
        now=current_time,
    )
    if not reserved:
        raise BridgeAuthError("replay detected")
