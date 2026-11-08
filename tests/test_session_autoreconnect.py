import unittest

from kagecatch.session_runtime import SessionRuntime


class FakeSessionManager:
    def __init__(self, users):
        self.users = users
        self.sessions = {user: f"session-{user}" for user in users}

    async def list_user_ids(self):
        return list(self.users)

    async def load_session(self, user_id):
        return self.sessions.get(user_id)


class FakeClient:
    def __init__(self, authorized=True):
        self.authorized = authorized
        self.connected = False
        self.disconnected = False

    async def connect(self):
        self.connected = True

    async def is_user_authorized(self):
        return self.authorized

    async def disconnect(self):
        self.disconnected = True


class SessionAutoReconnectTests(unittest.IsolatedAsyncioTestCase):
    async def test_restore_connects_every_saved_authorized_session(self):
        clients = {}
        manager = FakeSessionManager(["1001", "1002"])
        runtime = SessionRuntime(
            session_manager=manager,
            client_factory=lambda session: clients.setdefault(session, FakeClient()),
        )

        result = await runtime.restore_saved_sessions()

        self.assertEqual(result["connected"], 2)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(runtime.active_user_count, 2)
        self.assertTrue(all(client.connected for client in clients.values()))

    async def test_restore_continues_after_one_invalid_session(self):
        clients = {}
        manager = FakeSessionManager(["1001", "1002"])
        runtime = SessionRuntime(
            session_manager=manager,
            client_factory=lambda session: clients.setdefault(
                session, FakeClient(authorized=session != "session-1001")
            ),
        )

        result = await runtime.restore_saved_sessions()

        self.assertEqual(result["connected"], 1)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(runtime.active_user_count, 1)
        self.assertTrue(clients["session-1001"].disconnected)
        self.assertTrue(clients["session-1002"].connected)


if __name__ == "__main__":
    unittest.main()
