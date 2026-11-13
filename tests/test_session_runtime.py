import unittest
import logging

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

    async def test_registers_telegram_handlers_after_authorized_connection(self):
        registered = []

        async def register(client, user_id):
            registered.append((client, user_id))

        runtime = SessionRuntime(
            session_manager=FakeSessionManager({"user-a": "session-a"}),
            client_factory=lambda session: FakeClient(),
            handler_registrar=register,
        )
        client = await runtime.connect_user("user-a")

        self.assertEqual(registered, [(client, "user-a")])

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

    async def test_active_user_count_tracks_connected_clients(self):
        runtime = SessionRuntime(
            session_manager=FakeSessionManager({"user-a": "session-a", "user-b": "session-b"}),
            client_factory=lambda session: FakeClient(),
        )
        self.assertEqual(runtime.active_user_count, 0)
        await runtime.connect_user("user-a")
        await runtime.connect_user("user-b")
        self.assertEqual(runtime.active_user_count, 2)
        await runtime.disconnect_user("user-a")
        self.assertEqual(runtime.active_user_count, 1)

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


    async def test_reconnect_all_restores_saved_sessions_and_reports_counts(self):
        manager = FakeSessionManager({"user-a": "session-a", "user-b": "session-b"})
        async def list_user_ids():
            return list(manager.sessions)
        manager.list_user_ids = list_user_ids
        runtime = SessionRuntime(
            session_manager=manager,
            client_factory=lambda session: FakeClient(authorized=session != "session-b"),
        )
        result = await runtime.reconnect_all()
        self.assertEqual(result, {"connected": 1, "failed": 1})
        self.assertEqual(runtime.active_user_count, 1)


if __name__ == "__main__":
    unittest.main()

class SessionRuntimeTelemetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_authorized_reconnect_emits_structured_monitor_event_without_session_data(self):
        with self.assertLogs("kagecatch.core", level="INFO") as captured:
            await SessionRuntime(
                session_manager=FakeSessionManager({"user-a": "sensitive-session"}),
                client_factory=lambda session: FakeClient(),
            ).connect_user("user-a")
        events = [record for record in captured.records if getattr(record, "event_type", None) == "session_reconnected"]
        self.assertEqual(len(events), 1)
        self.assertNotIn("sensitive-session", events[0].getMessage())
