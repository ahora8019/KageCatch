import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from kagecatch.catch_admission import SQLiteCatchAdmissionStore
from kagecatch.catch_pipeline import CatchPipeline
from kagecatch.engine import CatchEngine, CatchReceipt
from kagecatch.models.spawn import CharacterMetadata, SpawnEvent


class FakeDetector:
    def __init__(self, spawn):
        self.spawn = spawn
        self.calls = 0

    async def detect(self, event):
        self.calls += 1
        return self.spawn


class FakeReviewPipeline:
    def __init__(self):
        self.calls = []

    async def process_spawn(self, *, spawn, user_id, event=None):
        self.calls.append((spawn, user_id, event))
        return {"status": "review_queued", "spawn_id": spawn.message_id}


class FakeCatchAdapter:
    source = "senpai_catcher"
    media_kind = "video"

    def __init__(self, *, verified=True, send_error=None):
        self.verified = verified
        self.send_error = send_error
        self.sent = []

    async def send_catch(self, spawn, character_name):
        self.sent.append((spawn.message_id, character_name))
        if self.send_error:
            raise self.send_error
        return CatchReceipt("SenpaiCatcherBot:77", character_name)

    async def verify_catch(self, receipt):
        return self.verified


def spawn_event(*, name=None, confidence=0.0, similarity=0.99, anime_confidence=0.99):
    return SpawnEvent(
        message_id=91,
        character_name=name,
        confidence_score=confidence,
        metadata=CharacterMetadata(
            anime_name="Example Anime",
            source="senpai_catcher",
            character_name=name,
            similarity=similarity,
            anime_confidence=anime_confidence,
            character_confidence=confidence,
        ),
        target_name="senpai_catcher",
        timestamp=datetime(2026, 11, 20, tzinfo=timezone.utc),
    )


class CatchPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.admission = SQLiteCatchAdmissionStore(
            Path(self.temp_dir.name) / "catch.sqlite3",
            max_attempts=3,
            window_seconds=60,
        )
        self.engine = CatchEngine(
            confidence_threshold=0.92,
            admission=self.admission,
            enabled=True,
        )
        self.adapter = FakeCatchAdapter()
        self.detector = FakeDetector(spawn_event(name="Megumin", confidence=0.99))
        self.review = FakeReviewPipeline()
        self.factory_calls = []

        def adapter_factory(user_id, event, detected_spawn):
            self.factory_calls.append((user_id, event, detected_spawn))
            return self.adapter

        self.pipeline = CatchPipeline(
            detector=self.detector,
            catch_engine=self.engine,
            adapter_factory=adapter_factory,
            catch_is_enabled=lambda user_id: True,
            review_pipeline=self.review,
        )

    async def asyncTearDown(self):
        self.temp_dir.cleanup()

    async def test_confident_character_identity_reaches_catch_engine_and_verifies_receipt(self):
        event = type("Event", (), {"chat_id": 100})()

        result = await self.pipeline.process(event=event, user_id="12345")

        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["character_name"], "Megumin")
        self.assertEqual(self.adapter.sent, [(91, "Megumin")])
        self.assertEqual(self.review.calls, [])
        self.assertEqual(self.detector.calls, 1)
        self.assertEqual(len(self.factory_calls), 1)

    async def test_anime_similarity_alone_never_dispatches_a_character_catch(self):
        self.detector.spawn = spawn_event(
            name=None,
            confidence=0.0,
            similarity=0.999,
            anime_confidence=0.999,
        )
        event = type("Event", (), {"chat_id": 100})()

        result = await self.pipeline.process(event=event, user_id="12345")

        self.assertEqual(result["status"], "review_queued")
        self.assertEqual(self.adapter.sent, [])
        self.assertEqual(len(self.review.calls), 1)
        self.assertEqual(self.detector.calls, 1)
        self.assertEqual(self.factory_calls, [])

    async def test_low_character_confidence_goes_to_manual_review_without_dispatch(self):
        self.detector.spawn = spawn_event(name="Megumin", confidence=0.50)
        event = type("Event", (), {"chat_id": 100})()

        result = await self.pipeline.process(event=event, user_id="12345")

        self.assertEqual(result["status"], "review_queued")
        self.assertEqual(self.adapter.sent, [])
        self.assertEqual(len(self.review.calls), 1)

    async def test_disabled_engine_uses_review_path_and_never_creates_adapter(self):
        disabled_engine = CatchEngine(
            confidence_threshold=0.92,
            admission=self.admission,
            enabled=False,
        )
        pipeline = CatchPipeline(
            detector=self.detector,
            catch_engine=disabled_engine,
            adapter_factory=lambda *args: self.factory_calls.append(args),
            catch_is_enabled=lambda user_id: True,
            review_pipeline=self.review,
        )

        result = await pipeline.process(
            event=type("Event", (), {"chat_id": 100})(),
            user_id="12345",
        )

        self.assertEqual(result["status"], "review_queued")
        self.assertEqual(self.factory_calls, [])
        self.assertEqual(self.adapter.sent, [])

    async def test_adapter_factory_failure_falls_back_to_manual_review(self):
        def broken_factory(*args):
            raise RuntimeError("runtime adapter unavailable")

        pipeline = CatchPipeline(
            detector=self.detector,
            catch_engine=self.engine,
            adapter_factory=broken_factory,
            catch_is_enabled=lambda user_id: True,
            review_pipeline=self.review,
        )

        result = await pipeline.process(
            event=type("Event", (), {"chat_id": 100})(),
            user_id="12345",
        )

        self.assertEqual(result["status"], "review_queued")
        self.assertEqual(self.adapter.sent, [])
        self.assertEqual(len(self.review.calls), 1)

    async def test_missing_chat_identity_falls_back_without_consuming_admission(self):
        result = await self.pipeline.process(
            event=object(),
            user_id="12345",
        )

        self.assertEqual(result["status"], "review_queued")
        self.assertEqual(self.adapter.sent, [])
        second = await self.admission.reserve(
            user_id="12345",
            source="senpai_catcher",
            dedupe_key="12345:senpai_catcher:100:91",
        )
        self.assertEqual(second, "admitted")

    async def test_ambiguous_send_failure_is_returned_without_requeueing_spawn(self):
        self.adapter.send_error = TimeoutError("unknown delivery outcome")
        result = await self.pipeline.process(
            event=type("Event", (), {"chat_id": 100})(),
            user_id="12345",
        )

        self.assertEqual(result["status"], "send_failed")
        self.assertEqual(self.adapter.sent, [(91, "Megumin")])
        self.assertEqual(self.review.calls, [])


    async def test_metadata_source_mismatch_falls_back_before_adapter_creation(self):
        from dataclasses import replace

        detected = spawn_event(name="Megumin", confidence=0.99)
        mismatched_metadata = replace(detected.metadata, source="henta_catcher")
        self.detector.spawn = replace(detected, metadata=mismatched_metadata)
        event = type("Event", (), {"chat_id": 100})()

        result = await self.pipeline.process(event=event, user_id="12345")

        self.assertEqual(result["status"], "review_queued")
        self.assertEqual(self.adapter.sent, [])
        self.assertEqual(self.factory_calls, [])
        self.assertEqual(len(self.review.calls), 1)


if __name__ == "__main__":
    unittest.main()
