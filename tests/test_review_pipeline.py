import unittest
from datetime import datetime, timezone

from kagecatch.review_pipeline import ReviewPipeline
from kagecatch.manual_review_queue import ReviewStatus


class FakeDetector:
    def __init__(self, spawn):
        self.spawn = spawn

    async def detect(self, event):
        return self.spawn


class FakeResolver:
    async def resolve(self, metadata):
        from kagecatch.character_resolver import ResolvedCharacter
        return ResolvedCharacter(
            character_name=None, confidence=50.0,
            source="local_mapping", candidates=("Megumin", "Aqua"),
        )


class FakeQueue:
    def __init__(self, *, fail=False):
        self.items = []
        self.fail = fail

    async def enqueue(self, *, user_id, spawn_id, anime_name, candidates):
        if self.fail:
            raise TimeoutError("D1 unavailable")
        item = {
            "user_id": user_id, "spawn_id": spawn_id,
            "anime_name": anime_name, "candidates": tuple(candidates),
            "status": ReviewStatus.PENDING,
        }
        self.items.append(item)
        return item


class ReviewPipelineTests(unittest.IsolatedAsyncioTestCase):
    def _spawn(self):
        from kagecatch.models.spawn import CharacterMetadata, SpawnEvent
        return SpawnEvent(
            message_id=91, character_name=None, confidence_score=0.0,
            metadata=CharacterMetadata(
                anime_name="KonoSuba", source="senpai",
                character_name=None, episode=3, similarity=0.91,
                anime_confidence=0.91, character_confidence=0.0,
            ),
            target_name="SenpaiCatcherBot",
            timestamp=datetime(2026, 11, 8, tzinfo=timezone.utc),
        )

    async def test_detected_spawn_is_resolved_and_persisted_for_manual_review(self):
        queue = FakeQueue()
        pipeline = ReviewPipeline(
            detector=FakeDetector(self._spawn()),
            resolver=FakeResolver(), review_queue=queue,
        )

        result = await pipeline.process(event=object(), user_id="12345")

        self.assertEqual(result.status, "review_queued")
        self.assertEqual(len(queue.items), 1)
        self.assertEqual(queue.items[0]["spawn_id"], 91)
        self.assertEqual(queue.items[0]["candidates"], ("Megumin", "Aqua"))

    async def test_no_spawn_does_not_create_review_item(self):
        queue = FakeQueue()
        pipeline = ReviewPipeline(
            detector=FakeDetector(None), resolver=FakeResolver(),
            review_queue=queue,
        )

        result = await pipeline.process(event=object(), user_id="12345")

        self.assertEqual(result.status, "no_spawn")
        self.assertEqual(queue.items, [])

    async def test_unknown_character_candidates_do_not_create_review_item(self):
        class EmptyResolver:
            async def resolve(self, metadata):
                return None

        queue = FakeQueue()
        pipeline = ReviewPipeline(
            detector=FakeDetector(self._spawn()), resolver=EmptyResolver(),
            review_queue=queue,
        )

        result = await pipeline.process(event=object(), user_id="12345")

        self.assertEqual(result.status, "no_candidates")
        self.assertEqual(queue.items, [])

    async def test_d1_failure_is_reported_without_crashing_the_pipeline(self):
        queue = FakeQueue(fail=True)
        pipeline = ReviewPipeline(
            detector=FakeDetector(self._spawn()),
            resolver=FakeResolver(), review_queue=queue,
        )

        result = await pipeline.process(event=object(), user_id="12345")

        self.assertEqual(result.status, "review_persistence_failed")
        self.assertIsNone(result.review_item)
        self.assertEqual(queue.items, [])

    async def test_invalid_user_id_is_rejected_before_processing(self):
        pipeline = ReviewPipeline(
            detector=FakeDetector(self._spawn()),
            resolver=FakeResolver(), review_queue=FakeQueue(),
        )

        with self.assertRaises(ValueError):
            await pipeline.process(event=object(), user_id="")


if __name__ == "__main__":
    unittest.main()
