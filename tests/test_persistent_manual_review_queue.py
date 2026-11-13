import unittest
from datetime import datetime, timedelta, timezone

from kagecatch.manual_review_queue import ReviewStatus
from kagecatch.persistent_manual_review_queue import PersistentManualReviewQueue


class MutableClock:
    def __init__(self):
        self.current = datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.current


class FakeDurableStore:
    def __init__(self):
        self.records = {}

    async def create(self, item):
        self.records[item["review_id"]] = {
            **item, "status": "pending", "selected_character": None,
        }

    async def list_pending(self, user_id):
        return [
            dict(item) for item in self.records.values()
            if item["user_id"] == user_id and item["status"] == "pending"
        ]

    async def resolve(self, *, user_id, review_id, action, candidate_index=None):
        item = self.records.get(review_id)
        if item is None or item["user_id"] != user_id:
            raise LookupError("review item not found")
        if item["status"] != "pending":
            raise ValueError("review item is already resolved")
        if action == "approve":
            if not 0 <= candidate_index < len(item["candidates"]):
                raise ValueError("candidate_index is out of range")
            item["status"] = "approved"
            item["selected_character"] = item["candidates"][candidate_index]
        else:
            item["status"] = "rejected"
        return dict(item)

    async def expire(self):
        return 0


class PersistentManualReviewQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_review_survives_queue_reconstruction(self):
        clock = MutableClock()
        store = FakeDurableStore()
        first_process = PersistentManualReviewQueue(store=store, clock=clock)
        created = await first_process.enqueue(
            user_id="12345", spawn_id=90, anime_name="KonoSuba",
            candidates=("Megumin", "Aqua"),
        )

        restarted_process = PersistentManualReviewQueue(store=store, clock=clock)
        pending = await restarted_process.get_pending(user_id="12345")

        self.assertEqual(pending, [created])
        self.assertEqual(pending[0].status, ReviewStatus.PENDING)

    async def test_approval_persists_selected_character_and_removes_pending_item(self):
        store = FakeDurableStore()
        queue = PersistentManualReviewQueue(store=store)
        item = await queue.enqueue(
            user_id="12345", spawn_id=90, anime_name="KonoSuba",
            candidates=("Megumin", "Aqua"),
        )

        approved = await queue.approve(
            user_id="12345", review_id=item.review_id, candidate_index=1,
        )

        self.assertEqual(approved.status, ReviewStatus.APPROVED)
        self.assertEqual(approved.selected_character, "Aqua")
        self.assertEqual(await queue.get_pending(user_id="12345"), [])

    async def test_other_users_cannot_read_or_resolve_a_review(self):
        store = FakeDurableStore()
        queue = PersistentManualReviewQueue(store=store)
        item = await queue.enqueue(
            user_id="12345", spawn_id=90, anime_name="KonoSuba",
            candidates=("Megumin",),
        )

        self.assertEqual(await queue.get_pending(user_id="99999"), [])
        with self.assertRaises(LookupError):
            await queue.reject(user_id="99999", review_id=item.review_id)

    async def test_reject_is_persisted_as_terminal_state(self):
        store = FakeDurableStore()
        queue = PersistentManualReviewQueue(store=store)
        item = await queue.enqueue(
            user_id="12345", spawn_id=90, anime_name="KonoSuba",
            candidates=("Megumin",),
        )

        rejected = await queue.reject(user_id="12345", review_id=item.review_id)

        self.assertEqual(rejected.status, ReviewStatus.REJECTED)
        self.assertIsNone(rejected.selected_character)

    async def test_rejects_worker_incompatible_payload_limits_before_persistence(self):
        store = FakeDurableStore()
        queue = PersistentManualReviewQueue(store=store)
        with self.assertRaises(ValueError):
            await queue.enqueue(user_id="12345", spawn_id=2**53, anime_name="KonoSuba", candidates=("Megumin",))
        with self.assertRaises(ValueError):
            await queue.enqueue(user_id="12345", spawn_id=1, anime_name="A" * 301, candidates=("Megumin",))
        with self.assertRaises(ValueError):
            await queue.enqueue(user_id="12345", spawn_id=1, anime_name="KonoSuba", candidates=("M" * 101,))
        with self.assertRaises(ValueError):
            await queue.enqueue(user_id="12345", spawn_id=1, anime_name="KonoSuba", candidates=tuple(f"C{i}" for i in range(31)))
        self.assertEqual(store.records, {})


    async def test_spawn_context_survives_queue_reconstruction(self):
        from kagecatch.models.spawn import SpawnContext

        store = FakeDurableStore()
        context = SpawnContext(
            source="senpai_catcher", chat_id=-1001234567890,
            message_id=90, media_kind="image",
        )
        first = PersistentManualReviewQueue(store=store)
        created = await first.enqueue(
            user_id="12345", spawn_id=90, anime_name="KonoSuba",
            candidates=("Megumin",), spawn_context=context,
        )

        restarted = PersistentManualReviewQueue(store=store)
        loaded = await restarted.get_pending(user_id="12345")

        self.assertEqual(loaded[0].spawn_context, context)
        self.assertEqual(created.spawn_context, context)

    async def test_expiry_delegates_to_durable_store(self):
        class ExpiringStore(FakeDurableStore):
            async def expire(self):
                return 4

        queue = PersistentManualReviewQueue(store=ExpiringStore())
        self.assertEqual(await queue.expire_old_items(), 4)


if __name__ == "__main__":
    unittest.main()
