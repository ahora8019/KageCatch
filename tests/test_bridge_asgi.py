import hashlib
import hmac
import json

import pytest

from kagecatch.bot.enrollment_handlers import EnrollmentBotHandler
from kagecatch.runtime.bridge import BRIDGE_PATH, EnrollmentBridge, SQLiteNonceStore
from kagecatch.runtime.bridge_asgi import EnrollmentBridgeASGI


SECRET = "a-long-random-shared-secret-for-asgi-tests"
NOW = 1_800_000_000


class FakeEnrollmentService:
    def __init__(self):
        self.cancelled = []

    async def cancel(self, owner_id):
        self.cancelled.append(owner_id)
        return True


def signed_headers(body, *, nonce="asgi_nonce_1234567890", method="POST", path=BRIDGE_PATH):
    timestamp = str(NOW)
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = "\n".join(("v1", method, path, timestamp, nonce, body_hash))
    signature = hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return [
        (b"x-kagecatch-timestamp", timestamp.encode()),
        (b"x-kagecatch-nonce", nonce.encode()),
        (b"x-kagecatch-signature", signature.encode()),
    ]


def update_body():
    return json.dumps({
        "update_id": 1,
        "message": {
            "from": {"id": 123},
            "chat": {"id": 123, "type": "private"},
            "text": "/cancel",
        },
    }).encode()


async def invoke(app, *, method="POST", path=BRIDGE_PATH, headers=None, body=b""):
    events = [{"type": "http.request", "body": body, "more_body": False}]
    sent = []

    async def receive():
        return events.pop(0)

    async def send(message):
        sent.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "path": path,
            "headers": headers or [],
        },
        receive,
        send,
    )
    start = next(item for item in sent if item["type"] == "http.response.start")
    response_body = next(item for item in sent if item["type"] == "http.response.body")
    return start["status"], json.loads(response_body["body"])


@pytest.mark.asyncio
async def test_asgi_endpoint_dispatches_valid_signed_request_and_returns_json_reply(tmp_path):
    service = FakeEnrollmentService()
    handler = EnrollmentBotHandler(service)
    bridge = EnrollmentBridge(
        handler,
        SECRET,
        SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
        clock=lambda: NOW,
    )
    app = EnrollmentBridgeASGI(bridge)
    body = update_body()

    status, payload = await invoke(app, headers=signed_headers(body), body=body)

    assert status == 200
    assert payload["ok"] is True
    assert payload["handled"] is True
    assert payload["reply"]["chat_id"] == 123
    assert service.cancelled == [123]


@pytest.mark.asyncio
async def test_asgi_endpoint_rejects_wrong_method_and_path(tmp_path):
    app = EnrollmentBridgeASGI(
        EnrollmentBridge(
            EnrollmentBotHandler(FakeEnrollmentService()),
            SECRET,
            SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
            clock=lambda: NOW,
        )
    )

    method_status, _ = await invoke(app, method="GET")
    path_status, _ = await invoke(app, path="/wrong")

    assert method_status == 405
    assert path_status == 404


@pytest.mark.asyncio
async def test_asgi_endpoint_rejects_duplicate_authentication_headers(tmp_path):
    app = EnrollmentBridgeASGI(
        EnrollmentBridge(
            EnrollmentBotHandler(FakeEnrollmentService()),
            SECRET,
            SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
            clock=lambda: NOW,
        )
    )
    body = update_body()
    headers = signed_headers(body)
    headers.append(headers[0])

    status, payload = await invoke(app, headers=headers, body=body)

    assert status == 400
    assert payload == {"ok": False, "error": "invalid_headers"}


@pytest.mark.asyncio
async def test_asgi_endpoint_stops_reading_oversized_request_body(tmp_path):
    app = EnrollmentBridgeASGI(
        EnrollmentBridge(
            EnrollmentBotHandler(FakeEnrollmentService()),
            SECRET,
            SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
            clock=lambda: NOW,
            max_body_bytes=32,
        ),
        max_body_bytes=32,
    )
    body = b"x" * 33

    status, payload = await invoke(app, headers=[], body=body)

    assert status == 413
    assert payload == {"ok": False, "error": "payload_too_large"}
