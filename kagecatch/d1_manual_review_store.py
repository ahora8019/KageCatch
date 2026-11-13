"""Signed HTTP adapter for Cloudflare D1-backed manual review records."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
import uuid
from urllib.parse import urlsplit

import httpx


class D1ManualReviewStore:
    """Transport review metadata through the authenticated Control Worker API."""

    PATH = "/internal/manual-review"

    def __init__(
        self,
        base_url: str,
        secret: str,
        *,
        client: httpx.AsyncClient | None = None,
        clock=time.time,
        nonce_factory=uuid.uuid4,
    ) -> None:
        if not isinstance(base_url, str):
            raise ValueError("manual review store URL must use HTTPS")
        parsed_url = urlsplit(base_url)
        is_loopback_http = (
            parsed_url.scheme == "http"
            and parsed_url.hostname in {"localhost", "127.0.0.1", "::1"}
            and parsed_url.port is not None
            and parsed_url.username is None
            and parsed_url.password is None
            and not parsed_url.query
            and not parsed_url.fragment
        )
        if parsed_url.scheme != "https" and not is_loopback_http:
            raise ValueError("manual review store URL must use HTTPS except for loopback development")
        if not isinstance(secret, str) or len(secret.encode("utf-8")) < 32:
            raise ValueError("manual review store secret must contain at least 32 bytes")
        self._base_url = base_url.rstrip("/")
        self._secret = secret.encode("utf-8")
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0), follow_redirects=False
        )
        self._owns_client = client is None
        self._clock = clock
        self._nonce_factory = nonce_factory

    async def create(self, item: dict) -> None:
        await self._request({"action": "create", **item})

    async def list_pending(self, user_id: str) -> list[dict]:
        result = await self._request({"action": "list", "user_id": user_id})
        items = result.get("items")
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise RuntimeError("manual review store returned an invalid item list")
        return items

    async def resolve(
        self, *, user_id: str, review_id: str, action: str,
        candidate_index: int | None = None,
    ) -> dict:
        if action not in {"approve", "reject"}:
            raise ValueError("invalid review action")
        payload = {
            "action": action, "user_id": user_id, "review_id": review_id,
        }
        if action == "approve":
            payload["candidate_index"] = candidate_index
        result = await self._request(payload)
        item = result.get("item")
        if not isinstance(item, dict):
            raise RuntimeError("manual review store returned an invalid item")
        return item

    async def expire(self) -> int:
        result = await self._request({"action": "expire"})
        expired = result.get("expired")
        if isinstance(expired, bool) or not isinstance(expired, int) or expired < 0:
            raise RuntimeError("manual review store returned an invalid expiry count")
        return expired

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _request(self, payload: dict) -> dict:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        timestamp = str(int(self._clock()))
        nonce_value = self._nonce_factory()
        nonce = nonce_value.hex if hasattr(nonce_value, "hex") else str(nonce_value)
        nonce = nonce.replace("-", "")
        if not re.fullmatch(r"[A-Za-z0-9_]{16,128}", nonce):
            raise ValueError("nonce factory returned an invalid nonce")
        body_hash = hashlib.sha256(body).hexdigest()
        signing_text = f"{timestamp}\n{nonce}\nPOST\n{self.PATH}\n{body_hash}"
        signature = hmac.new(
            self._secret, signing_text.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        response = await self._client.post(
            self._base_url + self.PATH,
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
            raise RuntimeError("manual review store returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise RuntimeError("manual review store returned an invalid response")
        return data
