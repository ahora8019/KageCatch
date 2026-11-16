"""Tests for recognition worker and conservative manual-review routing."""
import unittest

from kagecatch.recognition_worker import RecognitionWorker


class FakeQueue:
    def __init__(self, job):
        self.job = job
        self.completed = []
        self.failed = []
    async def claim_next(self, worker_id, *, lease_seconds=60):
        job, self.job = self.job, None
        return job
    async def complete(self, job_id, worker_id):
        self.completed.append((job_id, worker_id))
    async def fail(self, job_id, worker_id, *, retry_delay=0):
        self.failed.append((job_id, worker_id, retry_delay))
        return "queued"


class FakeResolver:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.metadata = result, error, None
    async def resolve(self, metadata):
        self.metadata = metadata
        if self.error:
            raise self.error
        return self.result


class FakeReviewQueue:
    def __init__(self, error=None):
        self.calls, self.error = [], error
    async def enqueue(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return {"id": "review-1"}


class Job:
    job_id = "job-1"
    payload = {
        "schema_version": 1,
        "user_id": "owner-1",
        "origin": {
            "source": "catcher", "chat_id": -1001, "message_id": 55,
            "media_kind": "image", "timestamp": None,
        },
        "recognition": {
            "anime_name": "Example Anime", "character_name": "untrusted guess",
            "confidence": 0.99, "character_confidence": 0.99,
            "anime_confidence": 0.98, "recognition_source": "fixture",
        },
        "target": {"name": "catcher"},
    }


class RecognitionWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_candidates_are_sent_to_manual_review_not_auto_selected(self):
        from types import SimpleNamespace
        queue = FakeQueue(Job())
        resolver = FakeResolver(SimpleNamespace(candidates=("A", "B"), source="local_mapping", confidence=0.5))
        reviews = FakeReviewQueue()
        worker = RecognitionWorker(queue=queue, resolver=resolver, review_queue=reviews, worker_id="recognizer")
        result = await worker.run_once()

        self.assertEqual(result.status, "review_queued")
        self.assertEqual(reviews.calls[0]["candidates"], ("A", "B"))
        self.assertIsNone(resolver.metadata.character_name)
        self.assertEqual(queue.completed, [("job-1", "recognizer")])
        self.assertEqual(queue.failed, [])

    async def test_missing_anime_is_rejected_and_job_completed_as_nonreviewable(self):
        queue = FakeQueue(Job())
        payload = dict(Job.payload)
        payload["recognition"] = dict(payload["recognition"], anime_name=None)
        job = type("BadJob", (), {"job_id": "job-2", "payload": payload})()
        queue.job = job
        resolver, reviews = FakeResolver(), FakeReviewQueue()
        worker = RecognitionWorker(queue=queue, resolver=resolver, review_queue=reviews, worker_id="recognizer")
        result = await worker.run_once()
        self.assertEqual(result.status, "invalid_metadata")
        self.assertEqual(queue.completed, [("job-2", "recognizer")])
        self.assertEqual(reviews.calls, [])

    async def test_resolver_failure_retries_job(self):
        queue = FakeQueue(Job())
        worker = RecognitionWorker(
            queue=queue, resolver=FakeResolver(error=RuntimeError("private detail")),
            review_queue=FakeReviewQueue(), worker_id="recognizer",
        )
        result = await worker.run_once()
        self.assertEqual(result.status, "retry_scheduled")
        self.assertEqual(len(queue.failed), 1)
        self.assertEqual(queue.completed, [])

    async def test_empty_candidate_result_is_completed_without_review(self):
        from types import SimpleNamespace
        queue = FakeQueue(Job())
        reviews = FakeReviewQueue()
        worker = RecognitionWorker(
            queue=queue, resolver=FakeResolver(SimpleNamespace(candidates=())),
            review_queue=reviews, worker_id="recognizer",
        )
        result = await worker.run_once()
        self.assertEqual(result.status, "no_candidates")
        self.assertEqual(queue.completed, [("job-1", "recognizer")])
        self.assertEqual(reviews.calls, [])

    async def test_review_persistence_failure_retries_job(self):
        from types import SimpleNamespace
        queue = FakeQueue(Job())
        worker = RecognitionWorker(
            queue=queue, resolver=FakeResolver(SimpleNamespace(candidates=("A",))),
            review_queue=FakeReviewQueue(error=RuntimeError("private detail")),
            worker_id="recognizer",
        )
        result = await worker.run_once()
        self.assertEqual(result.status, "retry_scheduled")
        self.assertEqual(queue.completed, [])
        self.assertEqual(len(queue.failed), 1)

    async def test_empty_queue_is_idle(self):
        queue = FakeQueue(None)
        worker = RecognitionWorker(
            queue=queue, resolver=FakeResolver(), review_queue=FakeReviewQueue(),
            worker_id="recognizer",
        )
        self.assertEqual((await worker.run_once()).status, "idle")


if __name__ == "__main__":
    unittest.main()
