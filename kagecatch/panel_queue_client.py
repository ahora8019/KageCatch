"""Signed client for enqueueing group dashboard requests through the Control Worker."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
import uuid

import httpx


class PanelQueueClient:
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
            raise ValueError("panel queue URL must use HTTPS")
        if not isinstance(secret, str) or len(secret.encode("utf-8")) < 32:
            raise ValueError("panel queue secret must contain at least 32 bytes")
        self._base_url = base_url.rstrip("/")
        self._secret = secret.encode("utf-8")
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0))
        self._owns_client = client is None
        self._clock = clock
        self._nonce_factory = nonce_factory

    async def enqueue(self, *, owner_id: str, chat_id: int, source_message_id: int) -> dict:
        if not isinstance(owner_id, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", owner_id):
            raise ValueError("valid numeric owner_id is required")
        if int(owner_id) > 2**52 - 1:
            raise ValueError("owner_id is out of range")
        if isinstance(chat_id, bool) or not isinstance(chat_id, int) or chat_id >= 0:
            raise ValueError("a Telegram group chat_id is required")
        if isinstance(source_message_id, bool) or not isinstance(source_message_id, int) or source_message_id <= 0:
            raise ValueError("valid source_message_id is required")

        path = "/internal/panel-requests"
        body = json.dumps(
            {"owner_id": owner_id, "chat_id": chat_id, "source_message_id": source_message_id},
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
        timestamp = str(int(self._clock()))
        nonce_value = self._nonce_factory()
        nonce = nonce_value.hex if hasattr(nonce_value, "hex") else str(nonce_value)
        nonce = nonce.replace("-", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce):
            raise ValueError("nonce factory returned an invalid nonce")
        body_hash = hashlib.sha256(body).hexdigest()
        signing_text = f"{timestamp}\n{nonce}\nPOST\n{path}\n{body_hash}"
        signature = hmac.new(self._secret, signing_text.encode("utf-8"), hashlib.sha256).hexdigest()
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
        result = response.json()
        if not isinstance(result, dict) or result.get("accepted") is not True:
            raise RuntimeError("panel queue returned an invalid response")
        return result

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()
