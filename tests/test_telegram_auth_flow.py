import unittest
from unittest.mock import AsyncMock

from telethon.errors import SessionPasswordNeededError

from kagecatch.telegram_auth_flow import TelegramAuthorizationFlow


class FakeSession:
    def __init__(self, value="partial-telethon-session"):
        self.value = value

    def save(self):
        return self.value


class FakeClient:
    def __init__(self, password_required=False, session_string="partial-telethon-session"):
        self.session = FakeSession(session_string)
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
        self.pending = {}

    async def save_pending_authorization(self, user_id, payload):
        self.pending[user_id] = dict(payload)

    async def load_pending_authorization(self, user_id):
        return self.pending.get(user_id)

    async def delete_pending_authorization(self, user_id):
        self.pending.pop(user_id, None)

    async def load_session(self, user_id):
        return None

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
        self.assertEqual(manager.saved, [("tg-1", "partial-telethon-session")])
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

    async def test_rejects_a_second_pending_login_for_same_user(self):
        client = FakeClient()
        flow = self.make_flow(client)
        await flow.start(user_id="tg-1", phone="+10000000000")

        with self.assertRaises(RuntimeError):
            await flow.start(user_id="tg-1", phone="+10000000001")

        self.assertTrue(client.connected)

    async def test_discards_pending_login_after_three_failed_codes(self):
        client = FakeClient()
        flow = self.make_flow(client, max_attempts=3)
        await flow.start(user_id="tg-1", phone="+10000000000")

        for _ in range(3):
            with self.assertRaises(ValueError):
                await flow.submit_code(user_id="tg-1", code="00000")

        self.assertFalse(client.connected)
        with self.assertRaises(LookupError):
            await flow.submit_code(user_id="tg-1", code="12345")

    async def test_pending_login_survives_flow_recreation(self):
        manager = FakeManager()
        first_client = FakeClient(password_required=True)
        first = self.make_flow(first_client, manager)
        await first.start(user_id="tg-1", phone="+10000000000")
        self.assertIn("tg-1", manager.pending)
        self.assertNotIn("12345", repr(manager.pending["tg-1"]))
        self.assertNotIn("private-password", repr(manager.pending["tg-1"]))

        resumed_client = FakeClient(password_required=True)
        second = TelegramAuthorizationFlow(
            client_factory=lambda: resumed_client,
            session_manager=manager,
        )
        result = await second.submit_code(user_id="tg-1", code="12345")
        self.assertEqual(result, "password_required")
        result = await second.submit_password(user_id="tg-1", password="private-password")
        self.assertEqual(result, "connected")
        self.assertEqual(len(manager.saved), 1)
        self.assertNotIn("tg-1", manager.pending)

    async def test_cancel_removes_persisted_pending_login(self):
        manager = FakeManager()
        flow = self.make_flow(FakeClient(), manager)
        await flow.start(user_id="tg-1", phone="+10000000000")
        await flow.cancel(user_id="tg-1")
        self.assertNotIn("tg-1", manager.pending)



class AuthorizationPersistenceRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_authorized_session_survives_a_temporary_final_store_failure(self):
        class FailOnceManager(FakeManager):
            def __init__(self):
                super().__init__()
                self.save_failures = 1

            async def save_authorized_session(self, user_id, session_string):
                if self.save_failures:
                    self.save_failures -= 1
                    raise OSError("session store temporarily unavailable")
                await super().save_authorized_session(user_id, session_string)

        manager = FailOnceManager()
        client = FakeClient()
        flow = TelegramAuthorizationFlow(
            client_factory=lambda: client,
            session_manager=manager,
        )

        await flow.start(user_id="tg-1", phone="+10000000000")
        first_result = await flow.submit_code(user_id="tg-1", code="12345")

        self.assertEqual(first_result, "persistence_pending")
        self.assertTrue(client.connected)
        self.assertIn("tg-1", manager.pending)
        self.assertTrue(manager.pending["tg-1"]["session_authorized"])
        self.assertEqual(manager.saved, [])

        status = await flow.get_status(user_id="tg-1")

        self.assertEqual(status["status"], "connected")
        self.assertEqual(manager.saved, [("tg-1", "partial-telethon-session")])
        self.assertNotIn("tg-1", manager.pending)
        self.assertFalse(client.connected)


    async def test_authorized_session_checkpoint_survives_process_restart_and_challenge_expiry(self):
        class FailOnceManager(FakeManager):
            def __init__(self):
                super().__init__()
                self.save_failures = 1

            async def save_authorized_session(self, user_id, session_string):
                if self.save_failures:
                    self.save_failures -= 1
                    raise OSError("temporary D1 outage")
                await super().save_authorized_session(user_id, session_string)

        manager = FailOnceManager()
        clock = [100.0]
        first_client = FakeClient()
        first_flow = TelegramAuthorizationFlow(
            client_factory=lambda: first_client,
            session_manager=manager,
            ttl_seconds=30,
            clock=lambda: clock[0],
        )

        await first_flow.start(user_id="tg-1", phone="+10000000000")
        self.assertEqual(
            await first_flow.submit_code(user_id="tg-1", code="12345"),
            "persistence_pending",
        )
        self.assertTrue(manager.pending["tg-1"]["session_authorized"])

        # Simulate the login challenge expiring and the Core process restarting.
        clock[0] = 10_000.0
        restored_clients = []

        def restored_client_factory(session_string):
            client = FakeClient(session_string=session_string)
            client.authorized = True
            restored_clients.append(client)
            return client

        restarted_flow = TelegramAuthorizationFlow(
            client_factory=restored_client_factory,
            session_manager=manager,
            ttl_seconds=30,
            clock=lambda: clock[0],
        )
        status = await restarted_flow.get_status(user_id="tg-1")

        self.assertEqual(status["status"], "connected")
        self.assertEqual(restored_clients[0].session.save(), "partial-telethon-session")
        self.assertEqual(manager.saved, [("tg-1", "partial-telethon-session")])
        self.assertNotIn("tg-1", manager.pending)
        self.assertFalse(restored_clients[0].connected)


if __name__ == "__main__":
    unittest.main()
