import unittest
from datetime import datetime, timedelta, timezone

from kagecatch.manual_review_queue import (
    ManualReviewQueue,
    ReviewStatus,
)


class MutableClock:
    def __init__(self):
        self.current = datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.current


class ManualReviewQueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clock = MutableClock()
        self.queue = ManualReviewQueue(
            default_ttl=timedelta(minutes=15),
            clock=self.clock,
        )

    async def test_enqueue_creates_pending_item_with_expiry(self):
        item = await self.queue.enqueue(
            user_id="user-1",
            spawn_id=77,
            anime_name="KonoSuba",
            candidates=("Megumin", "Aqua"),
        )

        self.assertEqual(item.status, ReviewStatus.PENDING)
        self.assertEqual(item.created_at, self.clock.current)
        self.assertEqual(item.expires_at, self.clock.current + timedelta(minutes=15))
        self.assertIsNone(item.selected_character)
        self.assertEqual(
            await self.queue.get_pending(user_id="user-1"),
            [item],
        )

    async def test_pending_items_are_isolated_per_user(self):
        first = await self.queue.enqueue(
            user_id="user-1",
            spawn_id=1,
            anime_name="KonoSuba",
            candidates=("Megumin",),
        )
        second = await self.queue.enqueue(
            user_id="user-2",
            spawn_id=2,
            anime_name="Re:Zero",
            candidates=("Rem",),
        )

        self.assertEqual(await self.queue.get_pending(user_id="user-1"), [first])
        self.assertEqual(await self.queue.get_pending(user_id="user-2"), [second])
        self.assertEqual(await self.queue.get_pending(user_id="user-3"), [])

    async def test_user_can_approve_only_their_own_review(self):
        item = await self.queue.enqueue(
            user_id="owner-1",
            spawn_id=9,
            anime_name="KonoSuba",
            candidates=("Megumin", "Aqua"),
        )

        with self.assertRaises(LookupError):
            await self.queue.approve(
                user_id="owner-2",
                review_id=item.review_id,
                candidate_index=0,
            )

        approved = await self.queue.approve(
            user_id="owner-1",
            review_id=item.review_id,
            candidate_index=1,
        )
        self.assertEqual(approved.status, ReviewStatus.APPROVED)
        self.assertEqual(approved.selected_character, "Aqua")
        self.assertEqual(await self.queue.get_pending(user_id="owner-1"), [])

    async def test_approve_rejects_out_of_range_candidate_index(self):
        item = await self.queue.enqueue(
            user_id="user-1",
            spawn_id=3,
            anime_name="KonoSuba",
            candidates=("Megumin",),
        )
        with self.assertRaises(ValueError):
            await self.queue.approve(
                user_id="user-1",
                review_id=item.review_id,
                candidate_index=1,
            )

    async def test_reject_marks_item_rejected(self):
        item = await self.queue.enqueue(
            user_id="user-1",
            spawn_id=4,
            anime_name="KonoSuba",
            candidates=("Megumin",),
        )
        rejected = await self.queue.reject(
            user_id="user-1",
            review_id=item.review_id,
        )
        self.assertEqual(rejected.status, ReviewStatus.REJECTED)
        self.assertIsNone(rejected.selected_character)

    async def test_expired_item_cannot_be_approved(self):
        item = await self.queue.enqueue(
            user_id="user-1",
            spawn_id=5,
            anime_name="KonoSuba",
            candidates=("Megumin",),
        )
        self.clock.current += timedelta(minutes=16)

        expired = await self.queue.approve(
            user_id="user-1",
            review_id=item.review_id,
            candidate_index=0,
        )
        self.assertEqual(expired.status, ReviewStatus.EXPIRED)
        self.assertIsNone(expired.selected_character)

    async def test_expire_old_items_counts_only_newly_expired_items(self):
        await self.queue.enqueue(
            user_id="user-1",
            spawn_id=6,
            anime_name="KonoSuba",
            candidates=("Megumin",),
        )
        await self.queue.enqueue(
            user_id="user-2",
            spawn_id=7,
            anime_name="Re:Zero",
            candidates=("Rem",),
        )
        self.clock.current += timedelta(minutes=16)

        self.assertEqual(await self.queue.expire_old_items(), 2)
        self.assertEqual(await self.queue.expire_old_items(), 0)
        self.assertEqual(await self.queue.get_pending(user_id="user-1"), [])

    async def test_enqueue_rejects_invalid_inputs(self):
        invalid_inputs = [
            {"user_id": "", "spawn_id": 1, "anime_name": "A", "candidates": ("X",)},
            {"user_id": "u", "spawn_id": -1, "anime_name": "A", "candidates": ("X",)},
            {"user_id": "u", "spawn_id": 1, "anime_name": " ", "candidates": ("X",)},
            {"user_id": "u", "spawn_id": 1, "anime_name": "A", "candidates": ()},
        ]
        for values in invalid_inputs:
            with self.subTest(values=values):
                with self.assertRaises(ValueError):
                    await self.queue.enqueue(**values)

    async def test_terminal_item_cannot_be_resolved_twice(self):
        item = await self.queue.enqueue(
            user_id="user-1",
            spawn_id=8,
            anime_name="KonoSuba",
            candidates=("Megumin",),
        )
        await self.queue.reject(user_id="user-1", review_id=item.review_id)

        with self.assertRaises(ValueError):
            await self.queue.approve(
                user_id="user-1",
                review_id=item.review_id,
                candidate_index=0,
            )


if __name__ == "__main__":
    unittest.main()
