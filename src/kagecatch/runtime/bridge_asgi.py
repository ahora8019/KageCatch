"""ASGI transport adapter for the authenticated Worker-to-Core bridge.

This module is framework-free. Host the returned ASGI application behind an
HTTPS reverse proxy and a production ASGI server such as Uvicorn or Hypercorn.
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from .bridge import BRIDGE_PATH, BridgeResult, EnrollmentBridge


_AUTH_HEADERS = {
    b"x-kagecatch-timestamp",
    b"x-kagecatch-nonce",
    b"x-kagecatch-signature",
}


class EnrollmentBridgeASGI:
    """Expose EnrollmentBridge as a bounded ASGI HTTP application."""

    def __init__(
        self,
        bridge: EnrollmentBridge,
        *,
        max_body_bytes: int = 64 * 1024,
    ) -> None:
        if isinstance(max_body_bytes, bool) or not isinstance(max_body_bytes, int) or max_body_bytes < 1:
            raise ValueError("max_body_bytes must be a positive integer")
        self._bridge = bridge
        self._max_body_bytes = max_body_bytes

    async def _respond(
        self,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        result: BridgeResult,
    ) -> None:
        body = json.dumps(
            result.payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": result.status_code,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"cache-control", b"no-store"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        if scope.get("type") != "http":
            return

        method = scope.get("method", "")
        path = scope.get("path", "")
        if method != "POST":
            await self._respond(
                send,
                BridgeResult(405, {"ok": False, "error": "method_not_allowed"}),
            )
            return
        if path != BRIDGE_PATH:
            await self._respond(
                send,
                BridgeResult(404, {"ok": False, "error": "not_found"}),
            )
            return

        headers: dict[str, str] = {}
        seen_auth_headers: set[bytes] = set()
        try:
            for raw_name, raw_value in scope.get("headers", []):
                name = raw_name.lower()
                if name in _AUTH_HEADERS:
                    if name in seen_auth_headers:
                        raise ValueError("duplicate authentication header")
                    seen_auth_headers.add(name)
                headers[raw_name.decode("ascii")] = raw_value.decode("latin-1")
        except (AttributeError, UnicodeDecodeError, ValueError):
            await self._respond(
                send,
                BridgeResult(400, {"ok": False, "error": "invalid_headers"}),
            )
            return

        chunks: list[bytes] = []
        body_size = 0
        while True:
            event = await receive()
            event_type = event.get("type")
            if event_type == "http.disconnect":
                return
            if event_type != "http.request":
                continue
            chunk = event.get("body", b"")
            if not isinstance(chunk, bytes):
                await self._respond(
                    send,
                    BridgeResult(400, {"ok": False, "error": "invalid_body"}),
                )
                return
            body_size += len(chunk)
            if body_size > self._max_body_bytes:
                await self._respond(
                    send,
                    BridgeResult(413, {"ok": False, "error": "payload_too_large"}),
                )
                return
            chunks.append(chunk)
            if not event.get("more_body", False):
                break

        result = await self._bridge.handle(
            method,
            path,
            headers,
            b"".join(chunks),
        )
        await self._respond(send, result)
