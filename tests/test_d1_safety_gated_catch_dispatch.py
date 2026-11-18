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

    async def send_message(self, username, command):
        self.sent.append((username, command))
        if self.error:
            raise self.error
        return FakeMessage()


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

    async def test_shared_reservation_precedes_telethon_send(self):
        telegram = FakeTelegramClient()
        safety = FakeDistributedSafetyClient()
        adapter = TelethonCatchAdapter(
            client=telegram,
            source="henta_catcher",
            dispatch_enabled=True,
            distributed_safety_client=safety,
            owner_id="7135051954",
        )

        receipt = await adapter.send_catch(self.spawn(), "Sakura")

        self.assertEqual(safety.reservations, [("7135051954", -100123456, 1)])
        self.assertEqual(telegram.sent, [("HentaCatcherBot", "/catch Sakura")])
        self.assertEqual(receipt.reference, "HentaCatcherBot:77")

    async def test_shared_reservation_denial_prevents_telegram_send(self):
        telegram = FakeTelegramClient()
        safety = FakeDistributedSafetyClient({"allowed": False, "reason": "owner_locked"})
        adapter = TelethonCatchAdapter(
            client=telegram,
            source="henta_catcher",
            dispatch_enabled=True,
            distributed_safety_client=safety,
            owner_id="7135051954",
        )

        with self.assertRaisesRegex(RuntimeError, "owner_locked"):
            await adapter.send_catch(self.spawn(), "Sakura")

        self.assertEqual(telegram.sent, [])

    async def test_shared_safety_service_failure_is_fail_closed(self):
        telegram = FakeTelegramClient()
        safety = FakeDistributedSafetyClient(error=OSError("control plane unavailable"))
        adapter = TelethonCatchAdapter(
            client=telegram,
            source="henta_catcher",
            dispatch_enabled=True,
            distributed_safety_client=safety,
            owner_id="7135051954",
        )

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


if __name__ == "__main__":
    unittest.main()
