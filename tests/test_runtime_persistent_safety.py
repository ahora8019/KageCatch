"""SessionRuntime wiring for durable per-owner Telegram safety locks."""
import tempfile
import unittest
from pathlib import Path

from kagecatch.session_runtime import SessionRuntime, SessionSafetyLockedError
from kagecatch.sqlite_safety_state_store import SQLiteSafetyStateStore


class SessionManagerFake:
    async def load_session(self, user_id):
        return "saved-session"


class RevokedClient:
    async def connect(self):
        raise type("SessionRevokedError", (Exception,), {})()
    async def is_user_authorized(self):
        return False
    async def disconnect(self):
        pass


class RuntimeSafetyPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_session_revocation_lock_blocks_reconnect_after_runtime_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "kagecatch.sqlite3"
            first_runtime = SessionRuntime(
                session_manager=SessionManagerFake(),
                client_factory=lambda session: RevokedClient(),
                safety_state_store=SQLiteSafetyStateStore(database),
            )
            with self.assertRaises(Exception) as first_error:
                await first_runtime.connect_user("owner-1")
            self.assertEqual(type(first_error.exception).__name__, "SessionRevokedError")

            factory_calls = []
            restarted_runtime = SessionRuntime(
                session_manager=SessionManagerFake(),
                client_factory=lambda session: factory_calls.append(session) or RevokedClient(),
                safety_state_store=SQLiteSafetyStateStore(database),
            )
            with self.assertRaises(SessionSafetyLockedError):
                await restarted_runtime.connect_user("owner-1")
            self.assertEqual(factory_calls, [])

    async def test_persistent_safety_state_is_scoped_to_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "kagecatch.sqlite3"
            runtime = SessionRuntime(
                session_manager=SessionManagerFake(),
                client_factory=lambda session: RevokedClient(),
                safety_state_store=SQLiteSafetyStateStore(database),
            )
            with self.assertRaises(Exception):
                await runtime.connect_user("owner-1")
            self.assertTrue(runtime.safety_guard_for("owner-2").check_send(chat_id=42).allowed)


if __name__ == "__main__":
    unittest.main()
