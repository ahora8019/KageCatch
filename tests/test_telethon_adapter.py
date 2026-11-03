import unittest

from kagecatch.runtime.telethon_adapter import (
    NoStoredSessionError,
    SessionAuthorizationError,
    TelethonSessionClient,
    TelethonSessionFactory,
)


class FakeSessionStore:
    def __init__(self, value: str | None = "stored-session") -> None:
        self.value = value
        self.saved: list[tuple[str, str]] = []

    def load(self, account_id: str) -> str | None:
        return self.value

    def save(self, account_id: str, session: str) -> None:
        self.saved.append((account_id, session))


class FakeTelethonSession:
    def __init__(self, session: str = "refreshed-session") -> None:
        self.session = type("Session", (), {"save": lambda _self: session})()
        self.connected = False
        self.authorized = True
        self.disconnect_calls = 0

    async def connect(self) -> None:
        self.connected = True

    async def is_user_authorized(self) -> bool:
        return self.authorized

    async def disconnect(self) -> None:
        self.disconnect_calls += 1
        self.connected = False

    def is_connected(self) -> bool:
        return self.connected


class TelethonSessionAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_connect_requires_authorization_and_persists_rotated_session(self) -> None:
        store = FakeSessionStore()
        client = FakeTelethonSession()
        adapter = TelethonSessionClient("account-1", client, store)

        await adapter.connect()

        self.assertTrue(adapter.is_connected())
        self.assertEqual(store.saved, [("account-1", "refreshed-session")])

    async def test_unauthorized_client_is_disconnected_and_rejected(self) -> None:
        store = FakeSessionStore()
        client = FakeTelethonSession()
        client.authorized = False
        adapter = TelethonSessionClient("account-1", client, store)

        with self.assertRaises(SessionAuthorizationError):
            await adapter.connect()

        self.assertFalse(adapter.is_connected())
        self.assertGreaterEqual(client.disconnect_calls, 1)

    async def test_disconnect_persists_session_before_closing(self) -> None:
        store = FakeSessionStore()
        client = FakeTelethonSession()
        adapter = TelethonSessionClient("account-1", client, store)
        await adapter.connect()

        await adapter.disconnect()

        self.assertFalse(adapter.is_connected())
        self.assertEqual(store.saved[-1], ("account-1", "refreshed-session"))

    async def test_factory_refuses_to_create_a_client_without_enrolled_session(self) -> None:
        store = FakeSessionStore(value=None)
        factory = TelethonSessionFactory(
            api_id=12345,
            api_hash="a" * 32,
            session_store=store,
            client_builder=lambda *_args: self.fail("client must not be built"),
        )

        with self.assertRaises(NoStoredSessionError):
            factory("account-1")

    async def test_factory_passes_only_the_requested_accounts_session_to_builder(self) -> None:
        store = FakeSessionStore(value="account-1-secret-session")
        received: list[tuple[str, int, str]] = []
        client = FakeTelethonSession()

        def builder(session: str, api_id: int, api_hash: str) -> FakeTelethonSession:
            received.append((session, api_id, api_hash))
            return client

        factory = TelethonSessionFactory(
            api_id=12345,
            api_hash="a" * 32,
            session_store=store,
            client_builder=builder,
        )

        adapter = factory("account-1")

        self.assertIsInstance(adapter, TelethonSessionClient)
        self.assertEqual(received, [("account-1-secret-session", 12345, "a" * 32)])


if __name__ == "__main__":
    unittest.main()
