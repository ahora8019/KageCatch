"""Signed client for the Cloudflare Worker Telegram safety endpoints.

This client is an async transport adapter only. It does not make the synchronous
TelegramSafetyGuard distributed-safe and must not be used as a substitute for
gating every Telethon outbound operation.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
import uuid

import httpx


MAX_SAFE_INTEGER = 2**53 - 1


class D1TelegramSafetyClient:
    def __init__(
        self,
        base_url: str,
        secret: str,
        *,
        client: httpx.AsyncClient | None = None,
        clock=time.time,
        nonce_factory=uuid.uuid4,
    ) -> None:
        if not isinstance(base_url, str) or not base_url.startswith("https://"):
            raise ValueError("Telegram safety URL must use HTTPS")
        if not isinstance(secret, str) or len(secret.encode("utf-8")) < 32:
            raise ValueError("Telegram safety secret must contain at least 32 bytes")
        self._base_url = base_url.rstrip("/")
        self._secret = secret.encode("utf-8")
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
            follow_redirects=False,
        )
        self._owns_client = client is None
        self._clock = clock
        self._nonce_factory = nonce_factory

    async def reserve_outbound(
        self,
        owner_id: str,
        chat_id: int | str,
        *,
        minimum_interval_seconds: int = 1,
        now: int | None = None,
    ) -> dict:
        self._validate_owner(owner_id)
        chat = self._validate_chat(chat_id)
        if (
            isinstance(minimum_interval_seconds, bool)
            or not isinstance(minimum_interval_seconds, int)
            or not 0 <= minimum_interval_seconds <= 60
        ):
            raise ValueError("minimum_interval_seconds must be an integer from 0 to 60")
        payload = {
            "ownerId": owner_id,
            "chatId": chat,
            "minimumIntervalSeconds": minimum_interval_seconds,
        }
        if now is not None:
            payload["now"] = self._validate_epoch(now, "now")
        result = await self._request("reserve", payload)
        if not isinstance(result.get("allowed"), bool):
            raise RuntimeError("Telegram safety API returned an invalid reservation response")
        if result["allowed"] and (
            isinstance(result.get("nextAllowedAt"), bool)
            or not isinstance(result.get("nextAllowedAt"), int)
            or result["nextAllowedAt"] < 0
        ):
            raise RuntimeError("Telegram safety API returned an invalid reservation deadline")
        return result

    async def update_backoff(
        self,
        owner_id: str,
        kind: str,
        until: int,
        *,
        now: int | None = None,
    ) -> dict:
        self._validate_owner(owner_id)
        if kind not in {"flood_wait", "bot_retry_after"}:
            raise ValueError("kind must be flood_wait or bot_retry_after")
        payload = {
            "ownerId": owner_id,
            "kind": kind,
            "until": self._validate_epoch(until, "until"),
        }
        if now is not None:
            payload["now"] = self._validate_epoch(now, "now")
        result = await self._request("backoff", payload)
        if result.get("updated") is not True:
            raise RuntimeError("Telegram safety API did not update the backoff")
        return result

    async def set_owner_lock(
        self,
        owner_id: str,
        locked: bool,
        *,
        reason: str | None = None,
        now: int | None = None,
    ) -> dict:
        self._validate_owner(owner_id)
        if not isinstance(locked, bool):
            raise ValueError("locked must be a boolean")
        if reason is not None and (
            not isinstance(reason, str) or len(reason) > 160
        ):
            raise ValueError("reason must be null or a string of at most 160 characters")
        payload = {"ownerId": owner_id, "locked": locked, "reason": reason}
        if now is not None:
            payload["now"] = self._validate_epoch(now, "now")
        result = await self._request("lock", payload)
        if result.get("updated") is not True or result.get("locked") is not locked:
            raise RuntimeError("Telegram safety API did not apply the requested lock state")
        return result

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _request(self, action: str, payload: dict) -> dict:
        if action not in {"reserve", "backoff", "lock"}:
            raise ValueError("invalid Telegram safety action")
        path = f"/internal/telegram-safety/{action}"
        body = json.dumps(
            payload, separators=(",", ":"), ensure_ascii=True, allow_nan=False
        ).encode("utf-8")
        timestamp = str(int(self._clock()))
        if not re.fullmatch(r"\d{10,12}", timestamp):
            raise ValueError("clock must return a 10 to 12 digit Unix timestamp")
        nonce_value = self._nonce_factory()
        nonce = nonce_value.hex if hasattr(nonce_value, "hex") else str(nonce_value)
        nonce = nonce.replace("-", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce):
            raise ValueError("nonce factory returned an invalid nonce")
        body_hash = hashlib.sha256(body).hexdigest()
        canonical = f"{timestamp}\n{nonce}\nPOST\n{path}\n{body_hash}"
        signature = hmac.new(
            self._secret, canonical.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        response = await self._client.post(
            self._base_url + path,
            content=body,
            headers={
                "content-type": "application/json",
                "X-KageCatch-Timestamp": timestamp,
                "X-KageCatch-Nonce": nonce,
                "X-KageCatch-Signature": signature,
            },
        )
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError as exc:
            raise RuntimeError("Telegram safety API returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise RuntimeError("Telegram safety API returned an invalid response")
        return data

    @staticmethod
    def _validate_owner(owner_id: str) -> None:
        if not isinstance(owner_id, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", owner_id):
            raise ValueError("valid numeric Telegram owner_id is required")
        if int(owner_id) > (2**52 - 1):
            raise ValueError("Telegram owner_id is out of range")

    @staticmethod
    def _validate_chat(chat_id: int | str) -> str:
        if isinstance(chat_id, bool) or not isinstance(chat_id, (int, str)):
            raise ValueError("chat_id must be a Telegram integer ID or decimal string")
        value = str(chat_id)
        if not re.fullmatch(r"-?[1-9][0-9]{0,19}", value):
            raise ValueError("valid numeric Telegram chat_id is required")
        return value

    @staticmethod
    def _validate_epoch(value: int, field: str) -> int:
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            or value > MAX_SAFE_INTEGER
        ):
            raise ValueError(f"{field} must be a safe non-negative integer")
        return value
