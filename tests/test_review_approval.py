import unittest

from kagecatch.engine import CatchEngine, CatchReceipt
from kagecatch.manual_review_queue import ManualReviewQueue
from kagecatch.review_approval import ReviewApprovalService


class FakeAdapter:
    source = "henta_catcher"
    media_kind = "image"

    def __init__(self):
        self.sent = []

    async def send_catch(self, spawn, character_name):
        self.sent.append((spawn.message_id, character_name))
        return CatchReceipt(reference="mock-receipt", character_name=character_name)

    async def verify_catch(self, receipt):
        return True


class FakeQuota:
    async def allow(self, user_id, source):
        return True


class FakeDeduplicator:
    def __init__(self):
        self.keys = set()

    async def claim(self, key):
        if key in self.keys:
            return False
        self.keys.add(key)
        return True


class ReviewApprovalServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.queue = ManualReviewQueue()
        self.item = await self.queue.enqueue(
            user_id="user-1", spawn_id=91, anime_name="KonoSuba",
            candidates=("Megumin", "Aqua"),
        )
        self.adapter = FakeAdapter()
        self.engine = CatchEngine(
            confidence_threshold=0.92, quota=FakeQuota(),
            deduplicator=FakeDeduplicator(), enabled=True,
        )

        async def load_spawn(user_id, spawn_id):
            from kagecatch.engine import Spawn
            return Spawn("henta_catcher", 777, spawn_id, "image", ())

        self.service = ReviewApprovalService(
            review_queue=self.queue, spawn_loader=load_spawn,
            engine=self.engine,
            adapter_resolver=lambda source: self.adapter if source == "henta_catcher" else None,
        )

    async def test_owner_approval_executes_only_selected_candidate(self):
        result = await self.service.approve_and_execute(
            user_id="user-1", review_id=self.item.review_id, candidate_index=1,
        )
        self.assertEqual(result.status, "verified")
        self.assertEqual(self.adapter.sent, [(91, "Aqua")])

    async def test_other_user_cannot_approve_or_execute_review(self):
        with self.assertRaises(LookupError):
            await self.service.approve_and_execute(
                user_id="user-2", review_id=self.item.review_id, candidate_index=0,
            )
        self.assertEqual(self.adapter.sent, [])
        self.assertEqual(await self.queue.get_pending(user_id="user-1"), [self.item])

    async def test_invalid_candidate_does_not_consume_review(self):
        with self.assertRaises(ValueError):
            await self.service.approve_and_execute(
                user_id="user-1", review_id=self.item.review_id, candidate_index=8,
            )
        self.assertEqual(await self.queue.get_pending(user_id="user-1"), [self.item])

    async def test_missing_spawn_context_does_not_consume_review(self):
        async def missing(user_id, spawn_id):
            return None
        service = ReviewApprovalService(
            review_queue=self.queue, spawn_loader=missing, engine=self.engine,
            adapter_resolver=lambda source: self.adapter,
        )
        with self.assertRaises(LookupError):
            await service.approve_and_execute(
                user_id="user-1", review_id=self.item.review_id, candidate_index=0,
            )
        self.assertEqual(await self.queue.get_pending(user_id="user-1"), [self.item])
        self.assertEqual(self.adapter.sent, [])

    async def test_spawn_context_must_match_review_message_id(self):
        async def mismatched(user_id, spawn_id):
            from kagecatch.engine import Spawn
            return Spawn("henta_catcher", 777, 999, "image", ())
        service = ReviewApprovalService(
            review_queue=self.queue, spawn_loader=mismatched, engine=self.engine,
            adapter_resolver=lambda source: self.adapter,
        )
        with self.assertRaises(ValueError):
            await service.approve_and_execute(
                user_id="user-1", review_id=self.item.review_id, candidate_index=0,
            )
        self.assertEqual(await self.queue.get_pending(user_id="user-1"), [self.item])
        self.assertEqual(self.adapter.sent, [])

    async def test_engine_disabled_does_not_execute_or_consume_review(self):
        self.engine.enabled = False
        result = await self.service.approve_and_execute(
            user_id="user-1", review_id=self.item.review_id, candidate_index=0,
        )
        self.assertEqual(result.status, "disabled")
        self.assertEqual(await self.queue.get_pending(user_id="user-1"), [self.item])
        self.assertEqual(self.adapter.sent, [])

    async def test_review_cannot_be_executed_twice(self):
        first = await self.service.approve_and_execute(
            user_id="user-1", review_id=self.item.review_id, candidate_index=0,
        )
        self.assertEqual(first.status, "verified")
        with self.assertRaises(LookupError):
            await self.service.approve_and_execute(
                user_id="user-1", review_id=self.item.review_id, candidate_index=0,
            )
        self.assertEqual(len(self.adapter.sent), 1)


if __name__ == "__main__":
    unittest.main()
