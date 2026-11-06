import asyncio
import unittest

from telethon.errors import SessionPasswordNeededError

from kagecatch.telegram_qr_auth_flow import TelegramQrAuthorizationFlow


class FakeQrLogin:
    def __init__(self, *, result="success"):
        self.url = "tg://login?token=opaque-one-time-token"
        self.result = result
        self.event = asyncio.Event()

    async def wait(self, timeout=None):
        if self.result == "timeout":
            raise asyncio.TimeoutError
        if self.result == "two_factor":
            raise SessionPasswordNeededError(request=None)
        await self.event.wait()
        return object()


class FakeSession:
    def save(self):
        return "private-telethon-session"


class FakeClient:
    def __init__(self, qr):
        self.qr = qr
        self.session = FakeSession()
        self.connected = False
        self.disconnected = False
        self.authorized = True
        self.qr_calls = 0

    async def connect(self):
        self.connected = True

    async def qr_login(self):
        self.qr_calls += 1
        return self.qr

    async def is_user_authorized(self):
        return self.authorized

    async def disconnect(self):
        self.disconnected = True
        self.connected = False


class FakeSessionManager:
    def __init__(self):
        self.saved = []

    async def save_authorized_session(self, user_id, session_string):
        self.saved.append((user_id, session_string))

    async def load_session(self, user_id):
        return None


class TelegramQrAuthorizationFlowTests(unittest.IsolatedAsyncioTestCase):
    def make_flow(self, client, manager=None):
        return TelegramQrAuthorizationFlow(
            client_factory=lambda: client,
            session_manager=manager or FakeSessionManager(),
            ttl_seconds=30,
        )

    async def test_start_returns_clickable_telegram_deep_link_without_qr_image(self):
        client = FakeClient(FakeQrLogin())
        flow = self.make_flow(client)
        result = await flow.start(user_id="2001")
        self.assertEqual(result["status"], "pending")
        self.assertTrue(result["login_url"].startswith("tg://login?token="))
        self.assertNotIn("qr_image", result)
        self.assertTrue(client.connected)
        await flow.cancel(user_id="2001")

    async def test_successful_deep_link_confirmation_persists_only_authorized_session(self):
        client = FakeClient(FakeQrLogin())
        manager = FakeSessionManager()
        flow = self.make_flow(client, manager)
        await flow.start(user_id="2001")
        client.qr.event.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        status = await flow.get_status(user_id="2001")
        self.assertEqual(status["status"], "connected")
        self.assertEqual(manager.saved, [("2001", "private-telethon-session")])
        self.assertTrue(client.disconnected)

    async def test_two_factor_requirement_fails_closed_without_collecting_password(self):
        client = FakeClient(FakeQrLogin(result="two_factor"))
        manager = FakeSessionManager()
        flow = self.make_flow(client, manager)
        await flow.start(user_id="2001")
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        status = await flow.get_status(user_id="2001")
        self.assertEqual(status["status"], "two_factor_required")
        self.assertEqual(manager.saved, [])
        self.assertTrue(client.disconnected)

    async def test_expired_link_is_reported_and_not_persisted(self):
        client = FakeClient(FakeQrLogin(result="timeout"))
        manager = FakeSessionManager()
        flow = self.make_flow(client, manager)
        await flow.start(user_id="2001")
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual((await flow.get_status(user_id="2001"))["status"], "expired")
        self.assertEqual(manager.saved, [])

    async def test_duplicate_start_reuses_the_same_pending_link(self):
        client = FakeClient(FakeQrLogin())
        flow = self.make_flow(client)
        first = await flow.start(user_id="2001")
        second = await flow.start(user_id="2001")
        self.assertEqual(first["login_url"], second["login_url"])
        self.assertEqual(client.qr_calls, 1)
        await flow.cancel(user_id="2001")

    async def test_cancel_discards_pending_link_and_disconnects_client(self):
        client = FakeClient(FakeQrLogin())
        flow = self.make_flow(client)
        await flow.start(user_id="2001")
        await flow.cancel(user_id="2001")
        self.assertEqual((await flow.get_status(user_id="2001"))["status"], "cancelled")
        self.assertTrue(client.disconnected)


if __name__ == "__main__":
    unittest.main()
