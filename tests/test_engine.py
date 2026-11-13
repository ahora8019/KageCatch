import unittest
import logging

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


if __name__ == "__main__":
    unittest.main()

class CatchEngineTelemetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_verified_catch_emits_structured_monitor_event_without_user_data(self):
        engine = CatchEngine(confidence_threshold=0.92, quota=FakeQuota(), deduplicator=FakeDeduplicator(), enabled=True)
        with self.assertLogs("kagecatch.core", level="INFO") as captured:
            result = await engine.handle_spawn("private-user-id", sample_spawn(), FakeAdapter())
        self.assertEqual(result.status, "verified")
        events = [record for record in captured.records if getattr(record, "event_type", None) == "catch_success"]
        self.assertEqual(len(events), 1)
        self.assertNotIn("private-user-id", events[0].getMessage())

    async def test_flood_wait_during_verification_emits_throttle_event(self):
        class FloodWaitError(Exception):
            pass

        class FloodWaitAdapter(FakeAdapter):
            async def verify_catch(self, receipt):
                raise FloodWaitError()

        engine = CatchEngine(confidence_threshold=0.92, quota=FakeQuota(), deduplicator=FakeDeduplicator(), enabled=True)
        with self.assertLogs("kagecatch.core", level="WARNING") as captured:
            result = await engine.handle_spawn("private-user-id", sample_spawn(), FloodWaitAdapter())
        self.assertEqual(result.status, "unverified")
        self.assertTrue(any(getattr(record, "event_type", None) == "flood_wait" for record in captured.records))
