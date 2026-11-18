import tempfile
import unittest
from pathlib import Path

from kagecatch.job_queue import SQLiteJobQueue


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
        first = await self.queue.enqueue("spawn.process", {"spawn_id": 12}, idempotency_key="source:chat:12")
        second = await self.queue.enqueue("spawn.process", {"spawn_id": 12}, idempotency_key="source:chat:12")
        self.assertEqual(first.job_id, second.job_id)
        self.assertEqual(await self.queue.pending_count(), 1)

    async def test_claim_is_atomic_and_respects_priority(self):
        low = await self.queue.enqueue("low", {"n": 1}, priority=1)
        high = await self.queue.enqueue("high", {"n": 2}, priority=10)
        claimed = await self.queue.claim_next("worker-a", lease_seconds=30)
        self.assertEqual(claimed.job_id, high.job_id)
        self.assertEqual(claimed.payload, {"n": 2})
        self.assertEqual((await self.queue.claim_next("worker-b", lease_seconds=30)).job_id, low.job_id)
        self.assertIsNone(await self.queue.claim_next("worker-c", lease_seconds=30))

    async def test_expired_lease_is_recovered_and_reclaimed(self):
        job = await self.queue.enqueue("spawn.process", {"spawn_id": 13})
        first = await self.queue.claim_next("worker-a", lease_seconds=10)
        self.assertEqual(first.job_id, job.job_id)
        self.now += 11
        self.assertEqual(await self.queue.recover_expired(), 1)
        second = await self.queue.claim_next("worker-b", lease_seconds=10)
        self.assertEqual(second.job_id, job.job_id)
        self.assertEqual(second.attempts, 2)
        self.assertGreater(second.lease_generation, first.lease_generation)

    async def test_only_current_lease_owner_can_complete(self):
        job = await self.queue.enqueue("spawn.process", {"spawn_id": 14})
        claim = await self.queue.claim_next("worker-a", lease_seconds=30)
        with self.assertRaises(PermissionError):
            await self.queue.complete(job.job_id, "worker-b", lease_generation=claim.lease_generation)
        await self.queue.complete(job.job_id, "worker-a", lease_generation=claim.lease_generation)
        self.assertEqual(await self.queue.pending_count(), 0)

    async def test_expired_worker_cannot_acknowledge_job(self):
        job = await self.queue.enqueue("spawn.process", {"spawn_id": 16})
        claim = await self.queue.claim_next("worker-a", lease_seconds=5)
        self.now += 6
        with self.assertRaises(PermissionError):
            await self.queue.complete(job.job_id, "worker-a", lease_generation=claim.lease_generation)

    async def test_failure_retries_then_moves_to_dead_letter(self):
        job = await self.queue.enqueue("spawn.process", {"spawn_id": 15}, max_attempts=2)
        first = await self.queue.claim_next("worker-a", lease_seconds=30)
        await self.queue.fail(job.job_id, "worker-a", lease_generation=first.lease_generation, retry_delay=0)
        second = await self.queue.claim_next("worker-b", lease_seconds=30)
        self.assertEqual(second.job_id, job.job_id)
        await self.queue.fail(job.job_id, "worker-b", lease_generation=second.lease_generation, retry_delay=0)
        self.assertEqual(await self.queue.pending_count(), 0)
        self.assertEqual(await self.queue.dead_letter_count(), 1)

    async def test_payload_must_be_json_object_and_job_type_bounded(self):
        with self.assertRaises(ValueError):
            await self.queue.enqueue("x" * 129, {"ok": True})
        with self.assertRaises(ValueError):
            await self.queue.enqueue("spawn.process", {"bad": object()})

    async def test_each_operation_closes_its_sqlite_connection(self):
        import sqlite3
        from unittest.mock import patch
        import kagecatch.job_queue as queue_module
        opened = []
        original_connect = sqlite3.connect

        class TrackingConnection(sqlite3.Connection):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.was_closed = False
            def close(self):
                self.was_closed = True
                return super().close()

        def tracked_connect(*args, **kwargs):
            kwargs["factory"] = TrackingConnection
            connection = original_connect(*args, **kwargs)
            opened.append(connection)
            return connection

        with patch.object(queue_module.sqlite3, "connect", side_effect=tracked_connect):
            await self.queue.enqueue("tracked", {"ok": True})
            await self.queue.pending_count()
            await self.queue.claim_next("tracked-worker")
        self.assertTrue(opened)
        self.assertTrue(all(connection.was_closed for connection in opened))

    async def test_stale_lease_generation_cannot_complete_reclaimed_job(self):
        job = await self.queue.enqueue("spawn.process", {"spawn_id": 99})
        first = await self.queue.claim_next("reused-worker", lease_seconds=5)
        self.now += 6
        self.assertEqual(await self.queue.recover_expired(), 1)
        second = await self.queue.claim_next("reused-worker", lease_seconds=5)
        self.assertEqual(first.job_id, second.job_id)
        with self.assertRaises(PermissionError):
            await self.queue.complete(job.job_id, "reused-worker", lease_generation=first.lease_generation)
        await self.queue.complete(job.job_id, "reused-worker", lease_generation=second.lease_generation)


if __name__ == "__main__":
    unittest.main()
