"""Tests for the detector-to-durable-queue ingestion boundary."""
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from kagecatch.job_queue import SQLiteJobQueue
from kagecatch.models.spawn import CharacterMetadata, SpawnContext, SpawnEvent
from kagecatch.spawn_ingestion import SpawnIngestionPipeline


class FakeDetector:
    def __init__(self, result):
        self.result = result
    async def detect(self, event):
        return self.result


def spawn_event(context=True):
    return SpawnEvent(
        message_id=42, character_name="Sakura", confidence_score=0.83,
        metadata=CharacterMetadata(
            anime_name="Example Anime", source="fixture", character_name="Sakura",
            character_confidence=0.83, anime_confidence=0.99,
            additional={"untrusted": "must-not-enter-queue"},
        ),
        target_name="henta_catcher",
        timestamp=datetime(2026, 1, 2, tzinfo=timezone.utc),
        spawn_context=SpawnContext("henta_catcher", -100123, 42, "image") if context else None,
    )


class SpawnIngestionPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.queue = SQLiteJobQueue(str(Path(self.temp.name) / "queue.sqlite3"))

    async def asyncTearDown(self):
        await self.queue.close()
        self.temp.cleanup()

    async def test_detected_spawn_is_serialized_and_enqueued_once(self):
        pipeline = SpawnIngestionPipeline(FakeDetector(spawn_event()), self.queue)
        first = await pipeline.ingest(object(), user_id="owner-1")
        second = await pipeline.ingest(object(), user_id="owner-1")
        self.assertEqual(first.status, "queued")
        self.assertEqual(second.job_id, first.job_id)
        self.assertEqual(await self.queue.pending_count(), 1)
        job = await self.queue.claim_next("recognition-worker")
        self.assertEqual(job.job_type, "spawn.recognize")
        self.assertEqual(job.payload["origin"]["message_id"], 42)
        self.assertEqual(job.payload["user_id"], "owner-1")
        self.assertNotIn("untrusted", str(job.payload))

    async def test_non_spawn_event_is_ignored_without_creating_job(self):
        pipeline = SpawnIngestionPipeline(FakeDetector(None), self.queue)
        result = await pipeline.ingest(object(), user_id="owner-1")
        self.assertEqual(result.status, "ignored")
        self.assertEqual(await self.queue.pending_count(), 0)

    async def test_spawn_without_trusted_origin_is_rejected(self):
        pipeline = SpawnIngestionPipeline(FakeDetector(spawn_event(False)), self.queue)
        result = await pipeline.ingest(object(), user_id="owner-1")
        self.assertEqual(result.status, "invalid_origin")
        self.assertEqual(await self.queue.pending_count(), 0)

    async def test_invalid_user_is_rejected(self):
        pipeline = SpawnIngestionPipeline(FakeDetector(spawn_event()), self.queue)
        with self.assertRaises(ValueError):
            await pipeline.ingest(object(), user_id="")

    async def test_ingestion_uses_target_chat_message_id_as_idempotency_key(self):
        pipeline = SpawnIngestionPipeline(FakeDetector(spawn_event()), self.queue)
        result = await pipeline.ingest(object(), user_id="owner-1")
        job = await self.queue.claim_next("worker")
        self.assertEqual(job.payload["origin"]["chat_id"], -100123)
        self.assertEqual(job.job_id, result.job_id)


if __name__ == "__main__":
    unittest.main()
