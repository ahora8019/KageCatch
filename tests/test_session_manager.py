import asyncio
import unittest

from kagecatch.runtime.sessions import SessionManager


class FakeSession:
    def __init__(self, *, fail_connect: bool = False) -> None:
        self.fail_connect = fail_connect
        self.connected = False
        self.connect_calls = 0
        self.disconnect_calls = 0

    async def connect(self) -> None:
        self.connect_calls += 1
        await asyncio.sleep(0)
        if self.fail_connect:
            raise RuntimeError("connection failed")
        self.connected = True

    async def disconnect(self) -> None:
        self.disconnect_calls += 1
        self.connected = False

    def is_connected(self) -> bool:
        return self.connected


class RetryDisconnectSession(FakeSession):
    def __init__(self) -> None:
        super().__init__()
        self.fail_once = True

    async def disconnect(self) -> None:
        self.disconnect_calls += 1
        if self.fail_once:
            self.fail_once = False
            raise RuntimeError("temporary disconnect failure")
        self.connected = False


class SessionManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_starts_and_tracks_a_session_for_one_account(self) -> None:
        session = FakeSession()
        manager = SessionManager(lambda _account_id: session)
        started = await manager.start("account-1")
        self.assertTrue(started)
        self.assertTrue(manager.is_running("account-1"))
        self.assertEqual(session.connect_calls, 1)

    async def test_start_is_idempotent_for_an_already_connected_account(self) -> None:
        session = FakeSession()
        manager = SessionManager(lambda _account_id: session)
        first = await manager.start("account-1")
        second = await manager.start("account-1")
        self.assertTrue(first)
        self.assertFalse(second)
        self.assertEqual(session.connect_calls, 1)

    async def test_sessions_are_isolated_between_accounts(self) -> None:
        sessions: dict[str, FakeSession] = {}
        manager = SessionManager(lambda account_id: sessions.setdefault(account_id, FakeSession()))
        await manager.start("account-1")
        await manager.start("account-2")
        self.assertTrue(manager.is_running("account-1"))
        self.assertTrue(manager.is_running("account-2"))
        self.assertIsNot(sessions["account-1"], sessions["account-2"])

    async def test_concurrent_start_creates_only_one_session_per_account(self) -> None:
        sessions: list[FakeSession] = []
        manager = SessionManager(lambda _account_id: sessions.append(FakeSession()) or sessions[-1])
        results = await asyncio.gather(
            manager.start("account-1"),
            manager.start("account-1"),
            manager.start("account-1"),
        )
        self.assertEqual(sum(results), 1)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].connect_calls, 1)

    async def test_failed_connection_is_not_registered_and_is_cleaned_up(self) -> None:
        session = FakeSession(fail_connect=True)
        manager = SessionManager(lambda _account_id: session)
        with self.assertRaisesRegex(RuntimeError, "connection failed"):
            await manager.start("account-1")
        self.assertFalse(manager.is_running("account-1"))
        self.assertEqual(session.disconnect_calls, 1)

    async def test_stop_disconnects_and_removes_only_the_requested_account(self) -> None:
        sessions: dict[str, FakeSession] = {}
        manager = SessionManager(lambda account_id: sessions.setdefault(account_id, FakeSession()))
        await manager.start("account-1")
        await manager.start("account-2")
        stopped = await manager.stop("account-1")
        self.assertTrue(stopped)
        self.assertFalse(manager.is_running("account-1"))
        self.assertTrue(manager.is_running("account-2"))
        self.assertEqual(sessions["account-1"].disconnect_calls, 1)
        self.assertEqual(sessions["account-2"].disconnect_calls, 0)

    async def test_disconnect_failure_keeps_session_registered_for_retry(self) -> None:
        session = RetryDisconnectSession()
        manager = SessionManager(lambda _account_id: session)
        await manager.start("account-1")
        with self.assertRaisesRegex(RuntimeError, "temporary disconnect failure"):
            await manager.stop("account-1")
        self.assertTrue(manager.is_running("account-1"))
        self.assertTrue(await manager.stop("account-1"))
        self.assertFalse(manager.is_running("account-1"))

    async def test_stopping_an_unknown_account_is_a_noop(self) -> None:
        manager = SessionManager(lambda _account_id: FakeSession())
        self.assertFalse(await manager.stop("missing"))

    async def test_rejects_empty_account_identifiers(self) -> None:
        manager = SessionManager(lambda _account_id: FakeSession())
        with self.assertRaises(ValueError):
            await manager.start("  ")
        with self.assertRaises(ValueError):
            manager.is_running("")


if __name__ == "__main__":
    unittest.main()
