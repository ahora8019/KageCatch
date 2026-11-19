import asyncio
import tempfile
import unittest
from pathlib import Path

from kagecatch.job_queue import IdempotencyConflictError, SQLiteJobQueue


class SQLiteJobQueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "jobs.sqlite3"
        self.now = 1_000.0
        self.queue = SQLiteJobQueue(str(self.path), clock=lambda: self.now)

    async def asyncTearDown(self):
        await self.queue.close()
        self.temp.cleanup()

    async def test_enqueue_is_durable_and_deduplicates_idempotency_key(self):
        first = await self.queue.enqueue("spawn.recognize", {"spawn_id": 12}, idempotency_key="source:chat:12")
        second = await self.queue.enqueue("spawn.recognize", {"spawn_id": 12}, idempotency_key="source:chat:12")
        self.assertEqual(first.job_id, second.job_id)
        self.assertEqual(await self.queue.pending_count(), 1)

    async def test_reusing_idempotency_key_for_different_work_is_rejected(self):
        await self.queue.enqueue("spawn.recognize", {"spawn_id": 12}, idempotency_key="same")
        with self.assertRaises(IdempotencyConflictError):
            await self.queue.enqueue("spawn.recognize", {"spawn_id": 13}, idempotency_key="same")

    async def test_claim_filters_job_types_and_respects_priority(self):
        await self.queue.enqueue("broadcast.send", {"n": 1}, priority=99)
        low = await self.queue.enqueue("spawn.recognize", {"n": 2}, priority=1)
        high = await self.queue.enqueue("spawn.recognize", {"n": 3}, priority=10)
        claimed = await self.queue.claim_next("recognizer", lease_seconds=30, job_types=("spawn.recognize",))
        self.assertEqual(claimed.job_id, high.job_id)
        self.assertEqual((await self.queue.claim_next("recognizer-2", job_types=("spawn.recognize",))).job_id, low.job_id)
        self.assertIsNone(await self.queue.claim_next("recognizer-3", job_types=("spawn.recognize",)))

    async def test_unfiltered_claim_preserves_general_queue_api(self):
        await self.queue.enqueue("spawn.recognize", {"n": 1})
        self.assertEqual((await self.queue.claim_next("any-worker")).job_type, "spawn.recognize")

    async def test_expired_lease_is_recovered_and_reclaimed(self):
        job = await self.queue.enqueue("spawn.recognize", {"spawn_id": 13})
        first = await self.queue.claim_next("worker-a", lease_seconds=10)
        self.assertEqual(first.job_id, job.job_id)
        self.now += 11
        self.assertEqual(await self.queue.recover_expired(), 1)
        second = await self.queue.claim_next("worker-b", lease_seconds=10)
        self.assertEqual(second.job_id, job.job_id)
        self.assertEqual(second.attempts, 2)
        self.assertGreater(second.lease_generation, first.lease_generation)

    async def test_only_current_lease_owner_can_complete(self):
        job = await self.queue.enqueue("spawn.recognize", {"spawn_id": 14})
        claim = await self.queue.claim_next("worker-a", lease_seconds=30)
        with self.assertRaises(PermissionError):
            await self.queue.complete(job.job_id, "worker-b", lease_generation=claim.lease_generation)
        await self.queue.complete(job.job_id, "worker-a", lease_generation=claim.lease_generation)
        self.assertEqual(await self.queue.pending_count(), 0)

    async def test_expired_worker_cannot_acknowledge_job(self):
        job = await self.queue.enqueue("spawn.recognize", {"spawn_id": 16})
        claim = await self.queue.claim_next("worker-a", lease_seconds=5)
        self.now += 6
        with self.assertRaises(PermissionError):
            await self.queue.complete(job.job_id, "worker-a", lease_generation=claim.lease_generation)

    async def test_non_finite_schedule_and_retry_delays_are_rejected(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(ValueError):
                await self.queue.enqueue("spawn.recognize", {"x": 1}, run_after=value)
            job = await self.queue.enqueue("spawn.recognize", {"x": 1})
            claimed = await self.queue.claim_next("worker")
            with self.assertRaises(ValueError):
                await self.queue.fail(job.job_id, "worker", lease_generation=claimed.lease_generation, retry_delay=value)
            await self.queue.complete(job.job_id, "worker", lease_generation=claimed.lease_generation)

    async def test_failure_retries_then_moves_to_dead_letter(self):
        job = await self.queue.enqueue("spawn.recognize", {"spawn_id": 15}, max_attempts=2)
        first = await self.queue.claim_next("worker-a", lease_seconds=30)
        await self.queue.fail(job.job_id, "worker-a", lease_generation=first.lease_generation, retry_delay=0)
        second = await self.queue.claim_next("worker-b", lease_seconds=30)
        self.assertEqual(second.job_id, job.job_id)
        await self.queue.fail(job.job_id, "worker-b", lease_generation=second.lease_generation, retry_delay=0)
        self.assertEqual(await self.queue.pending_count(), 0)
        self.assertEqual(await self.queue.dead_letter_count(), 1)

    async def test_malformed_job_can_be_quarantined_without_retry(self):
        job = await self.queue.enqueue("spawn.recognize", {"bad": True})
        claim = await self.queue.claim_next("worker-a")
        await self.queue.dead_letter(job.job_id, "worker-a", lease_generation=claim.lease_generation)
        self.assertEqual(await self.queue.dead_letter_count(), 1)
        self.assertEqual(await self.queue.pending_count(), 0)

    async def test_payload_must_be_json_object_and_job_type_bounded(self):
        with self.assertRaises(ValueError):
            await self.queue.enqueue("x" * 129, {"ok": True})
        with self.assertRaises(ValueError):
            await self.queue.enqueue("spawn.recognize", {"bad": object()})

    async def test_stale_lease_generation_cannot_complete_reclaimed_job(self):
        job = await self.queue.enqueue("spawn.recognize", {"spawn_id": 99})
        first = await self.queue.claim_next("reused-worker", lease_seconds=5)
        self.now += 6
        self.assertEqual(await self.queue.recover_expired(), 1)
        second = await self.queue.claim_next("reused-worker", lease_seconds=5)
        self.assertEqual(first.job_id, second.job_id)
        with self.assertRaises(PermissionError):
            await self.queue.complete(job.job_id, "reused-worker", lease_generation=first.lease_generation)
        await self.queue.complete(job.job_id, "reused-worker", lease_generation=second.lease_generation)


    async def test_idempotent_enqueue_is_safe_across_queue_instances(self):
        other = SQLiteJobQueue(str(self.path), clock=lambda: self.now)
        try:
            first, second = await asyncio.gather(
                self.queue.enqueue("spawn.recognize", {"spawn_id": 21}, idempotency_key="shared-key"),
                other.enqueue("spawn.recognize", {"spawn_id": 21}, idempotency_key="shared-key"),
            )
            self.assertEqual(first.job_id, second.job_id)
            self.assertEqual(await self.queue.pending_count(), 1)
        finally:
            await other.close()

    async def test_only_one_worker_across_queue_instances_can_claim_job(self):
        other = SQLiteJobQueue(str(self.path), clock=lambda: self.now)
        try:
            await self.queue.enqueue("spawn.recognize", {"spawn_id": 22})
            first, second = await asyncio.gather(
                self.queue.claim_next("worker-a"),
                other.claim_next("worker-b"),
            )
            claims = [claim for claim in (first, second) if claim is not None]
            self.assertEqual(len(claims), 1)
            self.assertIn(claims[0].worker_id, {"worker-a", "worker-b"})
        finally:
            await other.close()

    async def test_live_lease_can_be_renewed_without_changing_fence(self):
        job = await self.queue.enqueue("spawn.recognize", {"spawn_id": 25})
        claim = await self.queue.claim_next("worker-a", lease_seconds=5)
        old_generation = claim.lease_generation
        renewed_until = await self.queue.renew_lease(
            job.job_id, "worker-a",
            lease_generation=old_generation,
            lease_seconds=30,
        )
        self.assertEqual(renewed_until, self.now + 30)
        self.assertEqual(
            (await self.queue.claim_next("worker-b")),
            None,
        )
        await self.queue.complete(
            job.job_id, "worker-a", lease_generation=old_generation
        )

    async def test_expired_lease_cannot_be_renewed(self):
        job = await self.queue.enqueue("spawn.recognize", {"spawn_id": 26})
        claim = await self.queue.claim_next("worker-a", lease_seconds=5)
        self.now += 6
        with self.assertRaises(PermissionError):
            await self.queue.renew_lease(
                job.job_id, "worker-a",
                lease_generation=claim.lease_generation,
                lease_seconds=30,
            )

    async def test_scheduled_job_is_not_claimed_before_run_after(self):
        job = await self.queue.enqueue("spawn.recognize", {"spawn_id": 23}, run_after=self.now + 30)
        self.assertIsNone(await self.queue.claim_next("worker"))
        self.now += 30
        claimed = await self.queue.claim_next("worker")
        self.assertEqual(claimed.job_id, job.job_id)

    async def test_job_survives_queue_reopen(self):
        job = await self.queue.enqueue(
            "spawn.recognize", {"spawn_id": 24}, idempotency_key="durable-reopen"
        )
        await self.queue.close()
        reopened = SQLiteJobQueue(str(self.path), clock=lambda: self.now)
        try:
            claimed = await reopened.claim_next("restarted-worker")
            self.assertEqual(claimed.job_id, job.job_id)
            self.assertEqual(claimed.payload, {"spawn_id": 24})
        finally:
            await reopened.close()



    async def test_recovery_exhaustion_moves_crashed_job_to_dead_letter(self):
        job = await self.queue.enqueue(
            "spawn.recognize", {"spawn_id": 101}, max_attempts=2
        )
        first = await self.queue.claim_next("crashing-worker", lease_seconds=5)
        self.assertEqual(first.job_id, job.job_id)
        self.now += 6
        self.assertEqual(await self.queue.recover_expired(), 1)
        second = await self.queue.claim_next("recovery-worker", lease_seconds=5)
        self.assertEqual(second.attempts, 2)
        self.now += 6
        self.assertEqual(await self.queue.recover_expired(), 1)
        self.assertEqual(await self.queue.pending_count(), 0)
        self.assertEqual(await self.queue.dead_letter_count(), 1)


if __name__ == "__main__":
    unittest.main()
