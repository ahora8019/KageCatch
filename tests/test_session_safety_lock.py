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


if __name__ == "__main__":
    unittest.main()
