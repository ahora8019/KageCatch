import unittest

from kagecatch.catch_admission import SQLiteCatchAdmissionStore
from kagecatch.engine import (
    Candidate,
    CatchEngine,
    CatchReceipt,
    Spawn,
)


class FakeAdapter:
    source = "henta_catcher"
    media_kind = "image"

    def __init__(self, verified=True):
        self.sent = []
        self.verified = verified

    def build_command(self, character_name):
        return f"/catch {character_name}"

    async def send_catch(self, spawn, character_name):
        self.sent.append((spawn.message_id, character_name))
        return CatchReceipt(reference="out-1", character_name=character_name)

    async def verify_catch(self, receipt):
        return self.verified


class FakeQuota:
    def __init__(self, allowed=True):
        self.allowed = allowed

    async def allow(self, user_id, source):
        return self.allowed


class FakeDeduplicator:
    def __init__(self):
        self.seen = set()

    async def claim(self, key):
        if key in self.seen:
            return False
        self.seen.add(key)
        return True


def sample_spawn(confidence=0.99):
    return Spawn(
        source="henta_catcher",
        chat_id=100,
        message_id=200,
        media_kind="image",
        candidates=(Candidate("Sakura", confidence),),
    )


class CatchEngineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.adapter = FakeAdapter()
        self.quota = FakeQuota()
        self.deduplicator = FakeDeduplicator()
        self.engine = CatchEngine(
            confidence_threshold=0.92,
            quota=self.quota,
            deduplicator=self.deduplicator,
            enabled=True,
        )

    async def test_engine_is_safe_by_default_and_does_not_send(self):
        engine = CatchEngine(
            confidence_threshold=0.92,
            quota=self.quota,
            deduplicator=self.deduplicator,
        )
        result = await engine.handle_spawn("user-1", sample_spawn(), self.adapter)
        self.assertEqual(result.status, "disabled")
        self.assertEqual(self.adapter.sent, [])

    async def test_high_confidence_spawn_is_caught_and_verified(self):
        result = await self.engine.handle_spawn("user-1", sample_spawn(), self.adapter)
        self.assertEqual(result.status, "verified")
        self.assertEqual(self.adapter.sent, [(200, "Sakura")])

    async def test_low_confidence_spawn_is_not_caught(self):
        result = await self.engine.handle_spawn("user-1", sample_spawn(0.70), self.adapter)
        self.assertEqual(result.status, "needs_review")
        self.assertEqual(self.adapter.sent, [])

    async def test_quota_block_prevents_catch(self):
        self.quota.allowed = False
        result = await self.engine.handle_spawn("user-1", sample_spawn(), self.adapter)
        self.assertEqual(result.status, "quota_blocked")
        self.assertEqual(self.adapter.sent, [])

    async def test_duplicate_spawn_is_not_caught_twice(self):
        await self.engine.handle_spawn("user-1", sample_spawn(), self.adapter)
        result = await self.engine.handle_spawn("user-1", sample_spawn(), self.adapter)
        self.assertEqual(result.status, "duplicate")
        self.assertEqual(len(self.adapter.sent), 1)

    async def test_failed_verification_is_not_reported_as_success(self):
        self.adapter.verified = False
        result = await self.engine.handle_spawn("user-1", sample_spawn(), self.adapter)
        self.assertEqual(result.status, "unverified")

    async def test_wrong_media_kind_is_rejected_before_quota_or_send(self):
        spawn = Spawn(
            source="henta_catcher",
            chat_id=100,
            message_id=201,
            media_kind="video",
            candidates=(Candidate("Sakura", 0.99),),
        )
        result = await self.engine.handle_spawn("user-1", spawn, self.adapter)
        self.assertEqual(result.status, "media_mismatch")
        self.assertEqual(self.adapter.sent, [])

    async def test_wrong_adapter_is_rejected(self):
        spawn = sample_spawn()
        spawn = Spawn(
            source="senpai_catcher",
            chat_id=spawn.chat_id,
            message_id=spawn.message_id,
            media_kind="video",
            candidates=spawn.candidates,
        )
        result = await self.engine.handle_spawn("user-1", spawn, self.adapter)
        self.assertEqual(result.status, "adapter_mismatch")
        self.assertEqual(self.adapter.sent, [])


    async def test_malformed_candidate_name_is_ignored(self):
        spawn = Spawn(
            source="henta_catcher",
            chat_id=100,
            message_id=202,
            media_kind="image",
            candidates=(Candidate(None, 0.99), Candidate("Sakura", 0.95)),
        )
        result = await self.engine.handle_spawn("user-1", spawn, self.adapter)
        self.assertEqual(result.status, "verified")
        self.assertEqual(self.adapter.sent, [(202, "Sakura")])

    async def test_boolean_confidence_is_not_accepted(self):
        spawn = Spawn(
            source="henta_catcher",
            chat_id=100,
            message_id=203,
            media_kind="image",
            candidates=(Candidate("Sakura", True),),
        )
        result = await self.engine.handle_spawn("user-1", spawn, self.adapter)
        self.assertEqual(result.status, "no_match")
        self.assertEqual(self.adapter.sent, [])

    async def test_candidate_name_with_control_characters_is_ignored(self):
        spawn = Spawn(
            source="henta_catcher",
            chat_id=100,
            message_id=204,
            media_kind="image",
            candidates=(Candidate("Sakura\n/catch forged", 0.99),),
        )
        result = await self.engine.handle_spawn("user-1", spawn, self.adapter)
        self.assertEqual(result.status, "no_match")
        self.assertEqual(self.adapter.sent, [])




class FakeCatchAdmissionStore:
    def __init__(self, decision="admitted"):
        self.decision = decision
        self.keys = []

    async def reserve(self, *, user_id, source, dedupe_key):
        self.keys.append((user_id, source, dedupe_key))
        return self.decision


class CatchEngineAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_engine_uses_one_atomic_admission_result_for_quota_and_dedupe(self):
        admission = FakeCatchAdmissionStore("quota_blocked")
        engine = CatchEngine(
            confidence_threshold=0.92,
            admission=admission,
            enabled=True,
        )
        adapter = FakeAdapter()

        result = await engine.handle_spawn("user-1", sample_spawn(), adapter)

        self.assertEqual(result.status, "quota_blocked")
        self.assertEqual(adapter.sent, [])
        self.assertEqual(len(admission.keys), 1)
        self.assertEqual(admission.keys[0], (
            "user-1", "henta_catcher", "user-1:henta_catcher:100:200"
        ))

    async def test_engine_rejects_malformed_spawn_identity_before_admission(self):
        admission = FakeCatchAdmissionStore()
        engine = CatchEngine(
            confidence_threshold=0.92,
            admission=admission,
            enabled=True,
        )
        adapter = FakeAdapter()
        malformed = Spawn(
            source="henta_catcher",
            chat_id=True,
            message_id=200,
            media_kind="image",
            candidates=(Candidate("Sakura", 0.99),),
        )

        with self.assertRaises(ValueError):
            await engine.handle_spawn("user-1", malformed, adapter)

        self.assertEqual(admission.keys, [])
        self.assertEqual(adapter.sent, [])

    async def test_engine_rejects_noncanonical_user_id_before_admission(self):
        admission = FakeCatchAdmissionStore()
        engine = CatchEngine(
            confidence_threshold=0.92,
            admission=admission,
            enabled=True,
        )

        with self.assertRaises(ValueError):
            await engine.handle_spawn("  user-1  ", sample_spawn(), FakeAdapter())

        self.assertEqual(admission.keys, [])


class CatchEnginePersistentAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import tempfile
        from pathlib import Path
        from kagecatch.catch_admission import SQLiteCatchAdmissionStore

        self.temp_dir = tempfile.TemporaryDirectory()
        self.admission = SQLiteCatchAdmissionStore(
            Path(self.temp_dir.name) / "catch.sqlite3",
            max_attempts=2,
            window_seconds=60,
        )
        self.engine = CatchEngine(
            confidence_threshold=0.92,
            admission=self.admission,
            enabled=True,
        )
        self.adapter = FakeAdapter()

    async def asyncTearDown(self):
        self.temp_dir.cleanup()

    async def test_concurrent_duplicate_spawn_dispatches_only_once(self):
        import asyncio

        results = await asyncio.gather(*[
            self.engine.handle_spawn("user-1", sample_spawn(), self.adapter)
            for _ in range(20)
        ])

        statuses = [result.status for result in results]
        self.assertEqual(statuses.count("verified"), 1)
        self.assertEqual(statuses.count("duplicate"), 19)
        self.assertEqual(self.adapter.sent, [(200, "Sakura")])

    async def test_ambiguous_send_failure_keeps_dedupe_reservation(self):
        class UncertainAdapter(FakeAdapter):
            async def send_catch(self, spawn, character_name):
                self.sent.append((spawn.message_id, character_name))
                raise TimeoutError("the send outcome is unknown")

        adapter = UncertainAdapter()
        first = await self.engine.handle_spawn("user-1", sample_spawn(), adapter)
        retry = await self.engine.handle_spawn("user-1", sample_spawn(), adapter)

        self.assertEqual(first.status, "send_failed")
        self.assertEqual(retry.status, "duplicate")
        self.assertEqual(adapter.sent, [(200, "Sakura")])

    async def test_invalid_receipt_is_never_passed_to_verification(self):
        class InvalidReceiptAdapter(FakeAdapter):
            def __init__(self):
                super().__init__()
                self.verification_calls = 0

            async def send_catch(self, spawn, character_name):
                return CatchReceipt(reference="out-2", character_name="A different character")

            async def verify_catch(self, receipt):
                self.verification_calls += 1
                return True

        adapter = InvalidReceiptAdapter()
        result = await self.engine.handle_spawn("user-1", sample_spawn(), adapter)

        self.assertEqual(result.status, "invalid_receipt")
        self.assertEqual(adapter.verification_calls, 0)

    async def test_database_failure_fails_closed_without_sending(self):
        class UnavailableAdmission:
            async def reserve(self, **kwargs):
                raise OSError("database unavailable")

        engine = CatchEngine(
            confidence_threshold=0.92,
            admission=UnavailableAdmission(),
            enabled=True,
        )
        adapter = FakeAdapter()

        result = await engine.handle_spawn("user-1", sample_spawn(), adapter)

        self.assertEqual(result.status, "admission_unavailable")
        self.assertEqual(adapter.sent, [])


if __name__ == "__main__":
    unittest.main()
