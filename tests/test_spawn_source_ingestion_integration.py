import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from kagecatch.job_queue import SQLiteJobQueue
from kagecatch.spawn_ingestion import SpawnIngestionPipeline
from kagecatch.targets.senpai_catcher import MetadataLookupError


class FakeFrameExtractor:
    async def extract_first_frame(self, event):
        return b"fixture-jpeg"


class FakeTraceClient:
    async def search(self, image):
        return {"result": [{
            "anilist": {"title": {"english": "Fixture Anime"}},
            "episode": 2,
            "similarity": 0.96,
        }]}


def telegram_event(username, text, *, photo=False, video=False, message_id=10):
    message = SimpleNamespace(
        id=message_id,
        chat_id=-100777,
        message=text,
        photo=object() if photo else None,
        video=object() if video else None,
        media=None,
        date=None,
    )
    return SimpleNamespace(
        message=message,
        id=message_id,
        chat_id=-100777,
        sender=SimpleNamespace(username=username),
        sender_username=username,
        sender_id=None,
        raw_text=text,
        video=object() if video else None,
    )


class ThreeSourceIngestionIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.queue = SQLiteJobQueue(str(Path(self.temp.name) / "queue.sqlite3"))
        from kagecatch.targets.registry import build_default_spawn_detector
        self.detector = build_default_spawn_detector(
            senpai_frame_extractor=FakeFrameExtractor(),
            senpai_trace_client=FakeTraceClient(),
        )
        self.pipeline = SpawnIngestionPipeline(self.detector, self.queue)

    async def asyncTearDown(self):
        await self.queue.close()
        self.temp.cleanup()

    async def test_character_catcher_event_reaches_durable_queue_with_source_origin(self):
        event = telegram_event(
            "Character_Catcher_Bot",
            "🎁 A CHARACTER HAS SPAWNED IN THE CHAT! /catch [NAME]",
            photo=True,
            message_id=11,
        )
        result = await self.pipeline.ingest(event, user_id="owner-1")
        job = await self.queue.claim_next("worker")
        self.assertEqual(result.status, "queued")
        self.assertEqual(job.payload["origin"]["source"], "catcher")
        self.assertEqual(job.payload["origin"]["chat_id"], -100777)
        self.assertEqual(job.payload["origin"]["message_id"], 11)
        self.assertEqual(job.payload["origin"]["media_kind"], "image")

    async def test_hentai_catcher_event_reaches_durable_queue_with_source_origin(self):
        event = telegram_event(
            "HentaCatcherBot",
            "✦ NEW CHARACTER SPAWN ✦ A new character has appeared! "
            "Use /catch Name to claim. You have 90 seconds before escape!",
            photo=True,
            message_id=12,
        )
        result = await self.pipeline.ingest(event, user_id="owner-1")
        job = await self.queue.claim_next("worker")
        self.assertEqual(result.status, "queued")
        self.assertEqual(job.payload["origin"]["source"], "hentai_catcher")
        self.assertEqual(job.payload["origin"]["message_id"], 12)
        self.assertEqual(job.payload["recognition"]["anime_name"], None)

    async def test_senpai_video_event_reaches_queue_with_scene_metadata(self):
        event = telegram_event(
            "SenpaiCatcherBot",
            "A New Character Has Appeared! Who is this character? Use /pick",
            video=True,
            message_id=13,
        )
        result = await self.pipeline.ingest(event, user_id="owner-1")
        job = await self.queue.claim_next("worker")
        self.assertEqual(result.status, "queued")
        self.assertEqual(job.payload["origin"]["source"], "senpai_catcher")
        self.assertEqual(job.payload["origin"]["media_kind"], "video")
        self.assertEqual(job.payload["recognition"]["anime_name"], "Fixture Anime")

    async def test_unregistered_sender_is_ignored(self):
        event = telegram_event(
            "ImpersonatorBot",
            "A CHARACTER HAS SPAWNED IN THE CHAT! /catch [NAME]",
            photo=True,
        )
        result = await self.pipeline.ingest(event, user_id="owner-1")
        self.assertEqual(result.status, "ignored")
        self.assertEqual(await self.queue.pending_count(), 0)


if __name__ == "__main__":
    unittest.main()
