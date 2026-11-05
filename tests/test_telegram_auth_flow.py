import unittest
from unittest.mock import AsyncMock

from telethon.errors import SessionPasswordNeededError

from kagecatch.telegram_auth_flow import TelegramAuthorizationFlow


class FakeSession:
    def save(self):
        return "encrypted-after-manager"


class FakeClient:
    def __init__(self, password_required=False):
        self.session = FakeSession()
        self.password_required = password_required
        self.connected = False
        self.authorized = False
        self.phone_hash = "opaque-hash"

    async def connect(self):
        self.connected = True

    async def send_code_request(self, phone):
        self.phone = phone
        return type("SentCode", (), {"phone_code_hash": self.phone_hash})()

    async def sign_in(self, **kwargs):
        if "password" in kwargs:
            self.authorized = True
            return
        if self.password_required:
            raise SessionPasswordNeededError(request=None)
        if kwargs.get("code") != "12345":
            raise ValueError("invalid code")
        self.authorized = True

    async def is_user_authorized(self):
        return self.authorized

    async def disconnect(self):
        self.connected = False


class FakeManager:
    def __init__(self):
        self.saved = []

    async def save_authorized_session(self, user_id, session_string):
        self.saved.append((user_id, session_string))


class TelegramAuthorizationFlowTests(unittest.IsolatedAsyncioTestCase):
    def make_flow(self, client, manager=None, **kwargs):
        return TelegramAuthorizationFlow(
            client_factory=lambda: client,
            session_manager=manager or FakeManager(),
            **kwargs,
        )

    async def test_start_sends_code_and_keeps_client_pending(self):
        client = FakeClient()
        flow = self.make_flow(client)

        result = await flow.start(user_id="tg-1", phone="+10000000000")

        self.assertEqual(result, "code_sent")
        self.assertTrue(client.connected)
        self.assertEqual(client.phone, "+10000000000")

    async def test_code_authorizes_and_persists_only_confirmed_session(self):
        client = FakeClient()
        manager = FakeManager()
        flow = self.make_flow(client, manager)

        await flow.start(user_id="tg-1", phone="+10000000000")
        result = await flow.submit_code(user_id="tg-1", code="12345")

        self.assertEqual(result, "connected")
        self.assertEqual(manager.saved, [("tg-1", "encrypted-after-manager")])
        self.assertFalse(client.connected)

    async def test_two_factor_password_is_requested_as_a_separate_step(self):
        client = FakeClient(password_required=True)
        manager = FakeManager()
        flow = self.make_flow(client, manager)

        await flow.start(user_id="tg-1", phone="+10000000000")
        result = await flow.submit_code(user_id="tg-1", code="12345")
        self.assertEqual(result, "password_required")
        self.assertEqual(manager.saved, [])
        self.assertTrue(client.connected)

        result = await flow.submit_password(user_id="tg-1", password="private-password")

        self.assertEqual(result, "connected")
        self.assertEqual(len(manager.saved), 1)
        self.assertFalse(client.connected)

    async def test_invalid_code_does_not_persist_or_drop_pending_flow(self):
        client = FakeClient()
        manager = FakeManager()
        flow = self.make_flow(client, manager)

        await flow.start(user_id="tg-1", phone="+10000000000")
        with self.assertRaises(ValueError):
            await flow.submit_code(user_id="tg-1", code="00000")

        self.assertEqual(manager.saved, [])
        self.assertTrue(client.connected)

    async def test_cancel_disconnects_and_discards_pending_authorization(self):
        client = FakeClient()
        flow = self.make_flow(client)

        await flow.start(user_id="tg-1", phone="+10000000000")
        await flow.cancel(user_id="tg-1")

        self.assertFalse(client.connected)
        with self.assertRaises(LookupError):
            await flow.submit_code(user_id="tg-1", code="12345")

    async def test_expired_authorization_is_disconnected_and_rejected(self):
        client = FakeClient()
        clock = [100.0]
        flow = self.make_flow(client, ttl_seconds=30, clock=lambda: clock[0])

        await flow.start(user_id="tg-1", phone="+10000000000")
        clock[0] = 131.0

        with self.assertRaises(TimeoutError):
            await flow.submit_code(user_id="tg-1", code="12345")

        self.assertFalse(client.connected)


if __name__ == "__main__":
    unittest.main()
