"""Regression tests for preventing reconnect loops after Telegram revokes a session."""
import unittest

from kagecatch.session_runtime import SessionRuntime, SessionSafetyLockedError


class SessionManagerFake:
    async def load_session(self, user_id):
        return "stored-session"


class ClientFake:
    async def connect(self):
        raise type("SessionRevokedError", (Exception,), {})()

    async def is_user_authorized(self):
        return False

    async def disconnect(self):
        pass


class ActiveClientFake:
    def __init__(self):
        self.disconnected = False

    async def connect(self):
        pass

    async def is_user_authorized(self):
        return True

    async def disconnect(self):
        self.disconnected = True


class SessionSafetyLockTests(unittest.IsolatedAsyncioTestCase):
    async def test_revoked_session_is_not_reconnected_repeatedly(self):
        factory_calls = []

        def factory(session):
            factory_calls.append(session)
            return ClientFake()

        runtime = SessionRuntime(
            session_manager=SessionManagerFake(),
            client_factory=factory,
        )
        with self.assertRaises(Exception) as first:
            await runtime.connect_user("owner-1")
        self.assertEqual(type(first.exception).__name__, "SessionRevokedError")

        with self.assertRaises(SessionSafetyLockedError):
            await runtime.connect_user("owner-1")

        self.assertEqual(factory_calls, ["stored-session"])
        self.assertFalse(runtime.safety_guard_for("owner-1").check_send(chat_id=123).allowed)

    async def test_locked_existing_client_is_discarded_before_manual_reauthorization(self):
        clients = []

        def factory(session):
            client = ActiveClientFake()
            clients.append(client)
            return client

        runtime = SessionRuntime(
            session_manager=SessionManagerFake(),
            client_factory=factory,
        )
        original = await runtime.connect_user("owner-1")
        runtime.safety_guard_for("owner-1").observe_error(
            type("SessionRevokedError", (Exception,), {})()
        )

        with self.assertRaises(SessionSafetyLockedError):
            await runtime.connect_user("owner-1")

        self.assertTrue(original.disconnected)
        self.assertEqual(runtime.active_user_count, 0)
        self.assertIsNone(await runtime.get_client("owner-1"))
        self.assertEqual(len(clients), 1)


if __name__ == "__main__":
    unittest.main()
