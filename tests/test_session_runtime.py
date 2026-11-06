import unittest

from kagecatch.session_runtime import SessionRuntime


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


class FakeSessionManager:
    def __init__(self, sessions):
        self.sessions = sessions
        self.revoked = []

    async def load_session(self, user_id):
        return self.sessions.get(user_id)

    async def revoke_session(self, user_id):
        self.revoked.append(user_id)
        self.sessions.pop(user_id, None)


class SessionRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_connects_only_with_saved_authorized_session(self):
        manager = FakeSessionManager({"user-a": "encrypted-session-a"})
        clients = []

        def factory(session):
            client = FakeClient()
            clients.append((session, client))
            return client

        runtime = SessionRuntime(session_manager=manager, client_factory=factory)
        client = await runtime.connect_user("user-a")

        self.assertTrue(client.connected)
        self.assertIs(await runtime.get_client("user-a"), client)
        self.assertEqual(clients[0][0], "encrypted-session-a")

    async def test_does_not_connect_user_without_saved_session(self):
        runtime = SessionRuntime(
            session_manager=FakeSessionManager({}),
            client_factory=lambda session: FakeClient(),
        )
        with self.assertRaises(LookupError):
            await runtime.connect_user("unknown-user")

    async def test_unauthorized_session_is_disconnected_and_not_cached(self):
        manager = FakeSessionManager({"user-a": "revoked-session"})
        clients = []

        def factory(session):
            client = FakeClient(authorized=False)
            clients.append(client)
            return client

        runtime = SessionRuntime(session_manager=manager, client_factory=factory)
        with self.assertRaises(PermissionError):
            await runtime.connect_user("user-a")

        self.assertTrue(clients[0].disconnected)
        self.assertIsNone(await runtime.get_client("user-a"))

    async def test_users_receive_isolated_clients(self):
        manager = FakeSessionManager({"user-a": "session-a", "user-b": "session-b"})
        runtime = SessionRuntime(
            session_manager=manager,
            client_factory=lambda session: FakeClient(),
        )
        client_a = await runtime.connect_user("user-a")
        client_b = await runtime.connect_user("user-b")
        self.assertIsNot(client_a, client_b)

    async def test_revoke_disconnects_and_removes_saved_session(self):
        manager = FakeSessionManager({"user-a": "session-a"})
        runtime = SessionRuntime(
            session_manager=manager,
            client_factory=lambda session: FakeClient(),
        )
        client = await runtime.connect_user("user-a")
        await runtime.revoke_user("user-a")

        self.assertTrue(client.disconnected)
        self.assertEqual(manager.revoked, ["user-a"])
        self.assertIsNone(await runtime.get_client("user-a"))

    async def test_repeated_connect_reuses_same_client(self):
        calls = []
        runtime = SessionRuntime(
            session_manager=FakeSessionManager({"user-a": "session-a"}),
            client_factory=lambda session: calls.append(session) or FakeClient(),
        )
        first = await runtime.connect_user("user-a")
        second = await runtime.connect_user("user-a")
        self.assertIs(first, second)
        self.assertEqual(calls, ["session-a"])


if __name__ == "__main__":
    unittest.main()
