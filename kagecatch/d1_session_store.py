"""Cloudflare D1 session store accessed only through the signed Control Worker API.

SessionManager encrypts the Telethon StringSession before this adapter sees it.
This adapter transports ciphertext only and never holds a Cloudflare API token.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
import uuid
from urllib.parse import quote

import httpx


class D1SessionStore:
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
            raise ValueError("session store URL must use HTTPS")
        if not isinstance(secret, str) or len(secret.encode("utf-8")) < 32:
            raise ValueError("session store secret must contain at least 32 bytes")
        self._base_url = base_url.rstrip("/")
        self._secret = secret.encode("utf-8")
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0), follow_redirects=False)
        self._owns_client = client is None
        self._clock = clock
        self._nonce_factory = nonce_factory

    async def put(self, user_id: str, encrypted_session: bytes) -> None:
        self._validate_user(user_id)
        if not isinstance(encrypted_session, bytes) or not encrypted_session:
            raise ValueError("encrypted_session must be non-empty bytes")
        payload = {"ciphertext": base64.b64encode(encrypted_session).decode("ascii")}
        await self._request("PUT", user_id, payload)

    async def get(self, user_id: str) -> bytes | None:
        self._validate_user(user_id)
        try:
            result = await self._request("GET", user_id)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return None
            raise
        encoded = result.get("ciphertext") if isinstance(result, dict) else None
        if not isinstance(encoded, str) or not encoded:
            raise RuntimeError("session store returned an invalid response")
        try:
            return base64.b64decode(encoded, validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise RuntimeError("session store returned invalid ciphertext") from exc

    async def delete(self, user_id: str) -> None:
        self._validate_user(user_id)
        try:
            await self._request("DELETE", user_id)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                raise

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _request(self, method: str, user_id: str, payload: dict | None = None) -> dict:
        path = "/internal/session-store/" + quote(user_id, safe="")
        body = b"" if payload is None else json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        timestamp = str(int(self._clock()))
        nonce_value = self._nonce_factory()
        nonce = nonce_value.hex if hasattr(nonce_value, "hex") else str(nonce_value)
        nonce = nonce.replace("-", "")
        if not re.fullmatch(r"[A-Za-z0-9_]{16,128}", nonce):
            raise ValueError("nonce factory returned an invalid nonce")
        body_hash = hashlib.sha256(body).hexdigest()
        signing_text = f"{timestamp}\n{nonce}\n{method}\n{path}\n{body_hash}"
        signature = hmac.new(self._secret, signing_text.encode("utf-8"), hashlib.sha256).hexdigest()
        response = await self._client.request(
            method,
            self._base_url + path,
            content=body if body else None,
            headers={
                "X-KageCatch-Timestamp": timestamp,
                "X-KageCatch-Nonce": nonce,
                "X-KageCatch-Signature": signature,
                **({"content-type": "application/json"} if body else {}),
            },
        )
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError as exc:
            raise RuntimeError("session store returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise RuntimeError("session store returned an invalid response")
        return data

    @staticmethod
    def _validate_user(user_id: str) -> None:
        if not isinstance(user_id, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", user_id):
            raise ValueError("valid numeric Telegram user_id is required")
        if int(user_id) > (2**52 - 1):
            raise ValueError("Telegram user_id is out of range")
