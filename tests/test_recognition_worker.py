"""Tests for typed recognition work and conservative manual-review routing."""
import unittest
from types import SimpleNamespace

from kagecatch.recognition_worker import RecognitionWorker


class FakeQueue:
    def __init__(self, job):
        self.job = job
        self.completed = []
        self.failed = []
        self.quarantined = []
        self.claim_filters = []
        self.renewals = []
        self.renew_error = None
    async def claim_next(self, worker_id, *, lease_seconds=60, job_types=None):
        self.claim_filters.append(tuple(job_types or ()))
        job, self.job = self.job, None
        return job
    async def complete(self, job_id, worker_id, *, lease_generation):
        self.completed.append((job_id, worker_id, lease_generation))
    async def dead_letter(self, job_id, worker_id, *, lease_generation):
        self.quarantined.append((job_id, worker_id, lease_generation))
    async def fail(self, job_id, worker_id, *, lease_generation, retry_delay=0):
        self.failed.append((job_id, worker_id, retry_delay, lease_generation))
        return "queued"
    async def renew_lease(self, job_id, worker_id, *, lease_generation, lease_seconds=60):
        self.renewals.append((job_id, worker_id, lease_generation, lease_seconds))
        if self.renew_error:
            raise self.renew_error
        return 999999.0
    async def recover_expired(self):
        return 0


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
    lease_generation = 1
    payload = {
        "schema_version": 1,
        "user_id": "owner-1",
        "origin": {"source": "catcher", "chat_id": -1001, "message_id": 55, "media_kind": "image"},
        "recognition": {
            "anime_name": "Example Anime", "character_name": "untrusted guess",
            "anime_confidence": 0.98, "recognition_source": "fixture",
        },
    }


class RecognitionWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_claims_only_recognition_jobs_and_never_auto_selects(self):
        queue = FakeQueue(Job())
        resolver = FakeResolver(SimpleNamespace(candidates=("A", "B")))
        reviews = FakeReviewQueue()
        worker = RecognitionWorker(queue=queue, resolver=resolver, review_queue=reviews, worker_id="recognizer")
        result = await worker.run_once()

        self.assertEqual(result.status, "review_queued")
        self.assertEqual(queue.claim_filters, [("spawn.recognize",)])
        self.assertEqual(reviews.calls[0]["candidates"], ("A", "B"))
        self.assertEqual(reviews.calls[0]["idempotency_key"], "recognition:job-1")
        self.assertIsNone(resolver.metadata.character_name)
        self.assertEqual(queue.completed, [("job-1", "recognizer", 1)])

    async def test_invalid_payload_is_dead_lettered_not_silently_completed(self):
        job = SimpleNamespace(job_id="bad-1", lease_generation=2, payload={"schema_version": 9})
        queue = FakeQueue(job)
        worker = RecognitionWorker(queue=queue, resolver=FakeResolver(), review_queue=FakeReviewQueue(), worker_id="recognizer")
        result = await worker.run_once()
        self.assertEqual(result.status, "invalid_payload")
        self.assertEqual(queue.quarantined, [("bad-1", "recognizer", 2)])
        self.assertEqual(queue.completed, [])

    async def test_invalid_metadata_is_dead_lettered(self):
        payload = dict(Job.payload)
        payload["origin"] = {"source": "", "chat_id": -1, "message_id": 1, "media_kind": "image"}
        job = SimpleNamespace(job_id="bad-2", lease_generation=3, payload=payload)
        queue = FakeQueue(job)
        worker = RecognitionWorker(queue=queue, resolver=FakeResolver(), review_queue=FakeReviewQueue(), worker_id="recognizer")
        result = await worker.run_once()
        self.assertEqual(result.status, "invalid_metadata")
        self.assertEqual(len(queue.quarantined), 1)

    async def test_unsupported_media_kind_is_dead_lettered(self):
        payload = dict(Job.payload)
        payload["origin"] = dict(Job.payload["origin"], media_kind="audio")
        job = SimpleNamespace(job_id="bad-media", lease_generation=4, payload=payload)
        queue = FakeQueue(job)
        worker = RecognitionWorker(queue=queue, resolver=FakeResolver(), review_queue=FakeReviewQueue(), worker_id="recognizer")
        result = await worker.run_once()
        self.assertEqual(result.status, "invalid_metadata")
        self.assertEqual(queue.quarantined, [("bad-media", "recognizer", 4)])
        self.assertEqual(queue.completed, [])

    async def test_resolver_failure_retries_job(self):
        queue = FakeQueue(Job())
        worker = RecognitionWorker(queue=queue, resolver=FakeResolver(error=RuntimeError("private")),
                                   review_queue=FakeReviewQueue(), worker_id="recognizer")
        self.assertEqual((await worker.run_once()).status, "retry_scheduled")
        self.assertEqual(len(queue.failed), 1)

    async def test_review_persistence_failure_retries_job(self):
        queue = FakeQueue(Job())
        worker = RecognitionWorker(queue=queue, resolver=FakeResolver(SimpleNamespace(candidates=("A",))),
                                   review_queue=FakeReviewQueue(error=RuntimeError("private")),
                                   worker_id="recognizer")
        self.assertEqual((await worker.run_once()).status, "retry_scheduled")
        self.assertEqual(queue.completed, [])
        self.assertEqual(len(queue.failed), 1)

    async def test_no_candidates_completes_without_review(self):
        queue, reviews = FakeQueue(Job()), FakeReviewQueue()
        worker = RecognitionWorker(queue=queue, resolver=FakeResolver(SimpleNamespace(candidates=())),
                                   review_queue=reviews, worker_id="recognizer")
        self.assertEqual((await worker.run_once()).status, "no_candidates")
        self.assertEqual(queue.completed, [("job-1", "recognizer", 1)])
        self.assertEqual(reviews.calls, [])

    async def test_worker_loop_survives_transient_queue_recovery_error(self):
        class RecoveringQueue(FakeQueue):
            def __init__(self, stop_event):
                super().__init__(None)
                self.calls = 0
                self.stop_event = stop_event
            async def recover_expired(self):
                self.calls += 1
                if self.calls == 1:
                    raise OSError("temporary storage error")
                self.stop_event.set()
                return 0

        import asyncio
        stop = asyncio.Event()
        queue = RecoveringQueue(stop)
        worker = RecognitionWorker(
            queue=queue, resolver=FakeResolver(), review_queue=FakeReviewQueue(),
            worker_id="recognizer",
        )
        self.assertEqual(await worker.run_forever(stop_event=stop, idle_sleep=0.001), 0)
        self.assertEqual(queue.calls, 2)

    async def test_non_finite_retry_delay_is_rejected(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(ValueError):
                RecognitionWorker(
                    queue=FakeQueue(None), resolver=FakeResolver(),
                    review_queue=FakeReviewQueue(), worker_id="recognizer",
                    retry_delay=value,
                )


    async def test_long_running_handler_renews_lease(self):
        import asyncio
        queue = FakeQueue(Job())
        started = asyncio.Event()
        class SlowResolver(FakeResolver):
            async def resolve(self, metadata):
                started.set()
                await asyncio.sleep(0.4)
                return SimpleNamespace(candidates=())
        worker = RecognitionWorker(
            queue=queue, resolver=SlowResolver(), review_queue=FakeReviewQueue(),
            worker_id="recognizer", lease_seconds=1,
        )
        result = await worker.run_once()
        self.assertEqual(result.status, "no_candidates")
        self.assertGreaterEqual(len(queue.renewals), 1)
        self.assertEqual(queue.completed, [("job-1", "recognizer", 1)])

    async def test_lease_renewal_failure_cancels_processing_without_ack(self):
        import asyncio
        queue = FakeQueue(Job())
        queue.renew_error = PermissionError("lease was reclaimed")
        started = asyncio.Event()
        cancelled = asyncio.Event()
        class SlowResolver(FakeResolver):
            async def resolve(self, metadata):
                started.set()
                try:
                    await asyncio.sleep(5)
                except asyncio.CancelledError:
                    cancelled.set()
                    raise
        worker = RecognitionWorker(
            queue=queue, resolver=SlowResolver(), review_queue=FakeReviewQueue(),
            worker_id="recognizer", lease_seconds=1,
        )
        result = await worker.run_once()
        self.assertEqual(result.status, "lease_lost")
        self.assertTrue(started.is_set())
        self.assertTrue(cancelled.is_set())
        self.assertEqual(queue.completed, [])
        self.assertEqual(queue.failed, [])
        self.assertEqual(queue.quarantined, [])

    async def test_empty_queue_is_idle(self):
        worker = RecognitionWorker(queue=FakeQueue(None), resolver=FakeResolver(),
                                   review_queue=FakeReviewQueue(), worker_id="recognizer")
        self.assertEqual((await worker.run_once()).status, "idle")


if __name__ == "__main__":
    unittest.main()
