import asyncio
import tempfile
import unittest
from pathlib import Path

from kagecatch.catch_admission import SQLiteCatchAdmissionStore


class MutableClock:
    def __init__(self, value=1_000.0):
        self.value = value

    def __call__(self):
        return self.value


class SQLiteCatchAdmissionStoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.clock = MutableClock()
        self.store = SQLiteCatchAdmissionStore(
            Path(self.temp_dir.name) / "catch-admission.sqlite3",
            max_attempts=2,
            window_seconds=60,
            clock=self.clock,
        )

    async def asyncTearDown(self):
        self.temp_dir.cleanup()

    async def test_reserves_attempt_and_rejects_duplicate_spawn(self):
        first = await self.store.reserve(
            user_id="user-1", source="henta_catcher",
            dedupe_key="user-1:henta_catcher:100:200",
        )
        duplicate = await self.store.reserve(
            user_id="user-1", source="henta_catcher",
            dedupe_key="user-1:henta_catcher:100:200",
        )

        self.assertEqual(first, "admitted")
        self.assertEqual(duplicate, "duplicate")

    async def test_applies_configured_rolling_quota_per_user_and_source(self):
        first = await self.store.reserve(
            user_id="user-1", source="henta_catcher", dedupe_key="spawn-1",
        )
        second = await self.store.reserve(
            user_id="user-1", source="henta_catcher", dedupe_key="spawn-2",
        )
        blocked = await self.store.reserve(
            user_id="user-1", source="henta_catcher", dedupe_key="spawn-3",
        )

        self.assertEqual((first, second, blocked), ("admitted", "admitted", "quota_blocked"))

    async def test_quota_window_expires_without_erasing_duplicate_history(self):
        await self.store.reserve(
            user_id="user-1", source="henta_catcher", dedupe_key="spawn-1",
        )
        await self.store.reserve(
            user_id="user-1", source="henta_catcher", dedupe_key="spawn-2",
        )
        self.clock.value += 61

        admitted = await self.store.reserve(
            user_id="user-1", source="henta_catcher", dedupe_key="spawn-3",
        )
        duplicate = await self.store.reserve(
            user_id="user-1", source="henta_catcher", dedupe_key="spawn-1",
        )

        self.assertEqual(admitted, "admitted")
        self.assertEqual(duplicate, "duplicate")

    async def test_quota_isolated_by_user_and_source(self):
        first = await self.store.reserve(
            user_id="user-1", source="henta_catcher", dedupe_key="spawn-1",
        )
        other_user = await self.store.reserve(
            user_id="user-2", source="henta_catcher", dedupe_key="spawn-2",
        )
        other_source = await self.store.reserve(
            user_id="user-1", source="character_catcher", dedupe_key="spawn-3",
        )

        self.assertEqual((first, other_user, other_source), ("admitted", "admitted", "admitted"))

    async def test_concurrent_duplicate_reservations_admit_exactly_one(self):
        decisions = await asyncio.gather(*[
            self.store.reserve(
                user_id="user-1", source="henta_catcher", dedupe_key="same-spawn",
            )
            for _ in range(20)
        ])

        self.assertEqual(decisions.count("admitted"), 1)
        self.assertEqual(decisions.count("duplicate"), 19)

    async def test_invalid_admission_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            await self.store.reserve(user_id="", source="henta_catcher", dedupe_key="spawn")
        with self.assertRaises(ValueError):
            await self.store.reserve(user_id="user-1", source="../unsafe", dedupe_key="spawn")
        with self.assertRaises(ValueError):
            await self.store.reserve(user_id="user-1", source="henta_catcher", dedupe_key="")

    async def test_invalid_quota_configuration_is_rejected(self):
        database = Path(self.temp_dir.name) / "invalid.sqlite3"
        with self.assertRaises(ValueError):
            SQLiteCatchAdmissionStore(database, max_attempts=0, window_seconds=60)
        with self.assertRaises(ValueError):
            SQLiteCatchAdmissionStore(database, max_attempts=5, window_seconds=0)


if __name__ == "__main__":
    unittest.main()
