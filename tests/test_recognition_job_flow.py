import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from kagecatch.job_queue import SQLiteJobQueue
from kagecatch.models.spawn import CharacterMetadata, SpawnEvent
from kagecatch.recognition_job_producer import RecognitionJobProducer
from kagecatch.recognition_worker import RecognitionWorker


class Detector:
    async def detect(self, event):
        return SpawnEvent(
            message_id=event.message_id,
            character_name=None,
            confidence_score=0.0,
            metadata=CharacterMetadata(
                anime_name="KonoSuba", source="fixture", anime_confidence=0.94,
                character_name=None, character_confidence=0.0,
            ),
            target_name="SenpaiCatcherBot",
        )


class Resolver:
    async def resolve(self, metadata):
        self.last_metadata = metadata
        return SimpleNamespace(candidates=("Megumin", "Aqua"))


class ReviewQueue:
    def __init__(self):
        self.items = {}

    async def enqueue(self, **kwargs):
        key = kwargs["idempotency_key"]
        if key not in self.items:
            self.items[key] = {"id": "review-1", **kwargs}
        return self.items[key]


class RecognitionJobFlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_spawn_event_flows_through_sqlite_queue_to_durable_review_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = SQLiteJobQueue(str(Path(directory) / "jobs.sqlite3"))
            detector, resolver, reviews = Detector(), Resolver(), ReviewQueue()
            producer = RecognitionJobProducer(detector=detector, queue=queue)
            worker = RecognitionWorker(
                queue=queue, resolver=resolver, review_queue=reviews,
                worker_id="integration-worker",
            )
            event = SimpleNamespace(chat_id=-100123, message_id=551)

            first = await producer.process("987654", event)
            duplicate = await producer.process("987654", event)
            self.assertEqual(first, duplicate)
            self.assertEqual(await queue.pending_count(), 1)

            result = await worker.run_once()

            self.assertEqual(result.status, "review_queued")
            self.assertEqual(await queue.pending_count(), 0)
            self.assertEqual(len(reviews.items), 1)
            self.assertEqual(result.review_item["candidates"], ("Megumin", "Aqua"))
            self.assertIsNone(resolver.last_metadata.character_name)
            await queue.close()


if __name__ == "__main__":
    unittest.main()
