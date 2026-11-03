import hashlib
import hmac
import json

import pytest

from kagecatch.runtime.bridge import (
    EnrollmentBridge,
    SQLiteNonceStore,
    canonical_request,
)


class FakeEnrollmentService:
    def __init__(self):
        self.cancelled = []

    async def cancel(self, owner_id):
        self.cancelled.append(owner_id)
        return True


class CaptureMessenger:
    def __init__(self):
        self.messages = []

    async def send_message(self, chat_id, text):
        self.messages.append({"chat_id": chat_id, "text": text})


def signed_request(secret, body, *, method="POST", path="/internal/telegram-update",
                   timestamp=1_800_000_000, nonce="0123456789abcdefghijklmn"):
    signature = hmac.new(
        secret.encode(),
        canonical_request(method, path, str(timestamp), nonce, body),
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-KageCatch-Timestamp": str(timestamp),
        "X-KageCatch-Nonce": nonce,
        "X-KageCatch-Signature": signature,
    }


def valid_update(command="/cancel", user_id=12345):
    return json.dumps({
        "update_id": 91,
        "message": {
            "from": {"id": user_id},
            "chat": {"id": user_id, "type": "private"},
            "text": command,
        },
    }).encode()


@pytest.mark.asyncio
async def test_valid_signed_private_cancel_is_handled_and_returns_reply(tmp_path):
    secret = "a-long-random-shared-secret-for-tests"
    service = FakeEnrollmentService()
    messenger = CaptureMessenger()
    from kagecatch.bot.enrollment_handlers import EnrollmentBotHandler

    bridge = EnrollmentBridge(
        EnrollmentBotHandler(service, messenger),
        secret,
        SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
        clock=lambda: 1_800_000_000,
    )
    body = valid_update()
    result = await bridge.handle("POST", "/internal/telegram-update",
                                 signed_request(secret, body), body)

    assert result.status_code == 200
    assert result.payload["handled"] is True
    assert result.payload["reply"]["chat_id"] == 12345
    assert "لغو" in result.payload["reply"]["text"]
    assert service.cancelled == [12345]


@pytest.mark.asyncio
async def test_rejects_invalid_signature_without_calling_handler(tmp_path):
    secret = "a-long-random-shared-secret-for-tests"
    service = FakeEnrollmentService()
    messenger = CaptureMessenger()
    from kagecatch.bot.enrollment_handlers import EnrollmentBotHandler

    bridge = EnrollmentBridge(
        EnrollmentBotHandler(service, messenger), secret,
        SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
        clock=lambda: 1_800_000_000,
    )
    body = valid_update()
    headers = signed_request(secret, body)
    headers["X-KageCatch-Signature"] = "0" * 64

    result = await bridge.handle("POST", "/internal/telegram-update", headers, body)

    assert result.status_code == 401
    assert service.cancelled == []
    assert messenger.messages == []


@pytest.mark.asyncio
async def test_rejects_replayed_nonce_even_with_valid_signature(tmp_path):
    secret = "a-long-random-shared-secret-for-tests"
    service = FakeEnrollmentService()
    messenger = CaptureMessenger()
    from kagecatch.bot.enrollment_handlers import EnrollmentBotHandler

    bridge = EnrollmentBridge(
        EnrollmentBotHandler(service, messenger), secret,
        SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
        clock=lambda: 1_800_000_000,
    )
    body = valid_update()
    headers = signed_request(secret, body)

    first = await bridge.handle("POST", "/internal/telegram-update", headers, body)
    second = await bridge.handle("POST", "/internal/telegram-update", headers, body)

    assert first.status_code == 200
    assert second.status_code == 401
    assert service.cancelled == [12345]


@pytest.mark.asyncio
async def test_rejects_stale_timestamp_and_wrong_path(tmp_path):
    secret = "a-long-random-shared-secret-for-tests"
    service = FakeEnrollmentService()
    messenger = CaptureMessenger()
    from kagecatch.bot.enrollment_handlers import EnrollmentBotHandler

    bridge = EnrollmentBridge(
        EnrollmentBotHandler(service, messenger), secret,
        SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
        clock=lambda: 1_800_000_000,
    )
    body = valid_update()
    stale = signed_request(secret, body, timestamp=1_799_999_000)
    wrong_path = signed_request(secret, body, path="/wrong")

    stale_result = await bridge.handle("POST", "/internal/telegram-update", stale, body)
    path_result = await bridge.handle("POST", "/internal/telegram-update", wrong_path, body)

    assert stale_result.status_code == 401
    assert path_result.status_code == 401
    assert service.cancelled == []


@pytest.mark.asyncio
async def test_rejects_body_tampering_and_non_post_methods(tmp_path):
    secret = "a-long-random-shared-secret-for-tests"
    service = FakeEnrollmentService()
    messenger = CaptureMessenger()
    from kagecatch.bot.enrollment_handlers import EnrollmentBotHandler

    bridge = EnrollmentBridge(
        EnrollmentBotHandler(service, messenger), secret,
        SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
        clock=lambda: 1_800_000_000,
    )
    body = valid_update()
    headers = signed_request(secret, body)

    tampered = await bridge.handle("POST", "/internal/telegram-update", headers, body + b" ")
    method = await bridge.handle("GET", "/internal/telegram-update", headers, body)

    assert tampered.status_code == 401
    assert method.status_code == 405
    assert service.cancelled == []


@pytest.mark.asyncio
async def test_rejects_unsupported_commands_and_group_updates(tmp_path):
    secret = "a-long-random-shared-secret-for-tests"
    service = FakeEnrollmentService()
    messenger = CaptureMessenger()
    from kagecatch.bot.enrollment_handlers import EnrollmentBotHandler

    bridge = EnrollmentBridge(
        EnrollmentBotHandler(service, messenger), secret,
        SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
        clock=lambda: 1_800_000_000,
    )
    for update in (
        json.dumps({"update_id": 1, "message": {"from": {"id": 1}, "chat": {"id": 1, "type": "private"}, "text": "123456"}}).encode(),
        json.dumps({"update_id": 2, "message": {"from": {"id": 1}, "chat": {"id": -100, "type": "group"}, "text": "/cancel"}}).encode(),
    ):
        result = await bridge.handle("POST", "/internal/telegram-update",
                                     signed_request(secret, update, nonce="nonce_" + str(len(update)) + "abcdefghijkl"),
                                     update)
        assert result.status_code == 200
        assert result.payload["handled"] is False

    assert service.cancelled == []
    assert messenger.messages == []


@pytest.mark.asyncio
async def test_rejects_oversized_and_invalid_json_bodies(tmp_path):
    secret = "a-long-random-shared-secret-for-tests"
    service = FakeEnrollmentService()
    messenger = CaptureMessenger()
    from kagecatch.bot.enrollment_handlers import EnrollmentBotHandler

    bridge = EnrollmentBridge(
        EnrollmentBotHandler(service, messenger), secret,
        SQLiteNonceStore(tmp_path / "nonces.sqlite3"),
        clock=lambda: 1_800_000_000,
        max_body_bytes=128,
    )
    oversized = b"x" * 129
    invalid = b"{"
    large_result = await bridge.handle(
        "POST", "/internal/telegram-update",
        signed_request(secret, oversized, nonce="oversized_nonce_123456789"),
        oversized,
    )
    invalid_result = await bridge.handle(
        "POST", "/internal/telegram-update",
        signed_request(secret, invalid, nonce="invalid_json_nonce_123456"),
        invalid,
    )

    assert large_result.status_code == 413
    assert invalid_result.status_code == 400
