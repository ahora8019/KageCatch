import asyncio
import unittest

from kagecatch.session_runtime import SessionAlreadyLockedError, SessionRuntime


class FakeClient:
    def __init__(self):
        self.connected = False
        self.disconnected = False
        self.disconnect_event = asyncio.Event()

    async def connect(self):
        self.connected = True

    async def is_user_authorized(self):
        return True

    async def disconnect(self):
        self.disconnected = True
        self.disconnect_event.set()


class FakeSessionManager:
    async def load_session(self, user_id):
        return f"session-{user_id}"

    async def list_user_ids(self):
        return ["user-a"]


class SharedLeaseStore:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.owner = None


class FakeLease:
    def __init__(self, store, owner, *, acquire_allowed=True):
        self.store = store
        self.owner = owner
        self.acquire_allowed = acquire_allowed
        self.lost = asyncio.Event()
        self.held = False

    async def acquire(self, session_id):
        if not self.acquire_allowed:
            return False
        async with self.store.lock:
            if self.store.owner is not None:
                return False
            self.store.owner = self.owner
            self.held = True
            return True

    async def assert_held(self):
        if not self.held or self.lost.is_set():
            raise RuntimeError("lease is not held")

    def start_heartbeat(self):
        if not self.held:
            raise RuntimeError("cannot heartbeat without a lease")

    async def wait_lost(self):
        await self.lost.wait()

    async def release(self):
        async with self.store.lock:
            if self.store.owner == self.owner:
                self.store.owner = None
        self.held = False


class LeaseFactory:
    def __init__(self, store, owner, *, acquire_allowed=True):
        self.store = store
        self.owner = owner
        self.acquire_allowed = acquire_allowed
        self.instances = []

    def __call__(self, user_id):
        lease = FakeLease(self.store, self.owner, acquire_allowed=self.acquire_allowed)
        self.instances.append(lease)
        return lease


class SessionRuntimeDistributedLockTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_runtime_instances_cannot_connect_the_same_session(self):
        store = SharedLeaseStore()
        manager = FakeSessionManager()
        clients = []

        def client_factory(_session):
            client = FakeClient()
            clients.append(client)
            return client

        runtime_a = SessionRuntime(
            session_manager=manager,
            client_factory=client_factory,
            lease_factory=LeaseFactory(store, "instance-owner-a"),
        )
        runtime_b = SessionRuntime(
            session_manager=manager,
            client_factory=client_factory,
            lease_factory=LeaseFactory(store, "instance-owner-b"),
        )

        results = await asyncio.gather(
            runtime_a.connect_user("user-a"),
            runtime_b.connect_user("user-a"),
            return_exceptions=True,
        )

        self.assertEqual(sum(not isinstance(result, BaseException) for result in results), 1)
        self.assertEqual(sum(isinstance(result, SessionAlreadyLockedError) for result in results), 1)
        self.assertEqual(sum(client.connected for client in clients), 1)

    async def test_failed_acquire_fails_closed_before_client_creation_or_connect(self):
        clients = []
        runtime = SessionRuntime(
            session_manager=FakeSessionManager(),
            client_factory=lambda session: clients.append(FakeClient()) or clients[-1],
            lease_factory=LeaseFactory(SharedLeaseStore(), "instance-owner-a", acquire_allowed=False),
        )

        with self.assertRaises(SessionAlreadyLockedError):
            await runtime.connect_user("user-a")

        self.assertEqual(clients, [])

    async def test_lost_heartbeat_forces_immediate_client_disconnect(self):
        store = SharedLeaseStore()
        leases = LeaseFactory(store, "instance-owner-a")
        clients = []
        runtime = SessionRuntime(
            session_manager=FakeSessionManager(),
            client_factory=lambda session: clients.append(FakeClient()) or clients[-1],
            lease_factory=leases,
        )
        client = await runtime.connect_user("user-a")
        self.assertTrue(client.connected)

        leases.instances[0].lost.set()
        await asyncio.wait_for(client.disconnect_event.wait(), timeout=1)

        self.assertTrue(client.disconnected)
        self.assertIsNone(await runtime.get_client("user-a"))


if __name__ == "__main__":
    unittest.main()
