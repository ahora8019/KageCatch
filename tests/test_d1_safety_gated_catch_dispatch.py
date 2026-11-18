"""Distributed safety reservation must gate every automated catch send."""
import unittest

from kagecatch.engine import Candidate, Spawn
from kagecatch.telegram_catch_adapter import TelethonCatchAdapter


class FakeMessage:
    id = 77


class FakeTelegramClient:
    def __init__(self, error=None):
        self.error = error
        self.sent = []
        self.disconnected = False

    async def send_message(self, username, command):
        self.sent.append((username, command))
        if self.error:
            raise self.error
        return FakeMessage()

    async def disconnect(self):
        self.disconnected = True


class FakeDistributedSafetyClient:
    def __init__(self, result=None, error=None):
        self.result = result or {"allowed": True, "nextAllowedAt": 1_800_000_001}
        self.error = error
        self.reservations = []
        self.backoffs = []
        self.locks = []

    async def reserve_outbound(self, owner_id, chat_id, *, minimum_interval_seconds=1):
        self.reservations.append((owner_id, chat_id, minimum_interval_seconds))
        if self.error:
            raise self.error
        return self.result

    async def update_backoff(self, owner_id, kind, until):
        self.backoffs.append((owner_id, kind, until))
        return {"updated": True}

    async def set_owner_lock(self, owner_id, locked, *, reason=None):
        self.locks.append((owner_id, locked, reason))
        return {"updated": True, "locked": locked}


class DistributedCatchDispatchTests(unittest.IsolatedAsyncioTestCase):
    def spawn(self):
        return Spawn(
            source="henta_catcher",
            chat_id=-100123456,
            message_id=987,
            media_kind="image",
            candidates=(Candidate("Sakura", 0.99),),
        )

    def adapter(self, telegram=None, safety=None, **kwargs):
        return TelethonCatchAdapter(
            client=telegram or FakeTelegramClient(),
            source="henta_catcher",
            dispatch_enabled=True,
            distributed_safety_client=safety or FakeDistributedSafetyClient(),
            owner_id="7135051954",
            wall_clock=lambda: 1_800_000_000,
            **kwargs,
        )

    async def test_shared_reservation_precedes_telethon_send(self):
        telegram = FakeTelegramClient()
        safety = FakeDistributedSafetyClient()
        adapter = self.adapter(telegram, safety)

        receipt = await adapter.send_catch(self.spawn(), "Sakura")

        self.assertEqual(safety.reservations, [("7135051954", -100123456, 1)])
        self.assertEqual(telegram.sent, [("HentaCatcherBot", "/catch Sakura")])
        self.assertEqual(receipt.reference, "HentaCatcherBot:77")

    async def test_shared_reservation_denial_prevents_telegram_send(self):
        telegram = FakeTelegramClient()
        safety = FakeDistributedSafetyClient({"allowed": False, "reason": "owner_locked"})
        adapter = self.adapter(telegram, safety)

        with self.assertRaisesRegex(RuntimeError, "owner_locked"):
            await adapter.send_catch(self.spawn(), "Sakura")

        self.assertEqual(telegram.sent, [])

    async def test_shared_safety_service_failure_is_fail_closed(self):
        telegram = FakeTelegramClient()
        safety = FakeDistributedSafetyClient(error=OSError("control plane unavailable"))
        adapter = self.adapter(telegram, safety)

        with self.assertRaises(OSError):
            await adapter.send_catch(self.spawn(), "Sakura")

        self.assertEqual(telegram.sent, [])

    async def test_distributed_dispatch_requires_owner_identity(self):
        with self.assertRaisesRegex(ValueError, "owner_id"):
            TelethonCatchAdapter(
                client=FakeTelegramClient(),
                source="henta_catcher",
                dispatch_enabled=True,
                distributed_safety_client=FakeDistributedSafetyClient(),
            )

    async def test_distributed_dispatch_requires_a_safety_client(self):
        with self.assertRaisesRegex(RuntimeError, "safety"):
            TelethonCatchAdapter(
                client=FakeTelegramClient(),
                source="henta_catcher",
                dispatch_enabled=True,
            )

    async def test_flood_wait_is_persisted_in_shared_backoff(self):
        error = type("FloodWaitError", (Exception,), {"seconds": 8})()
        telegram = FakeTelegramClient(error)
        safety = FakeDistributedSafetyClient()
        adapter = self.adapter(telegram, safety)

        with self.assertRaises(type(error)):
            await adapter.send_catch(self.spawn(), "Sakura")

        self.assertEqual(safety.backoffs, [("7135051954", "flood_wait", 1_800_000_008)])

    async def test_session_revocation_sets_shared_owner_lock_and_disconnects(self):
        error = type("SessionRevokedError", (Exception,), {})()
        telegram = FakeTelegramClient(error)
        safety = FakeDistributedSafetyClient()
        adapter = self.adapter(telegram, safety)

        with self.assertRaises(type(error)):
            await adapter.send_catch(self.spawn(), "Sakura")

        self.assertEqual(safety.locks, [("7135051954", True, "session_revoked")])
        self.assertTrue(telegram.disconnected)

    async def test_failed_shared_error_update_fails_closed(self):
        error = type("FloodWaitError", (Exception,), {"seconds": 8})()
        telegram = FakeTelegramClient(error)
        safety = FakeDistributedSafetyClient()
        async def fail_update(owner_id, kind, until):
            raise OSError("shared store unavailable")
        safety.update_backoff = fail_update
        adapter = self.adapter(telegram, safety)

        with self.assertRaisesRegex(RuntimeError, "refusing further catch dispatch"):
            await adapter.send_catch(self.spawn(), "Sakura")


if __name__ == "__main__":
    unittest.main()
