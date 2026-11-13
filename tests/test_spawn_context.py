import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from kagecatch.spawn_detector import SpawnDetector


class SpawnContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_detector_extracts_trusted_chat_source_and_media_context(self):
        metadata = SimpleNamespace(
            anime_name="KonoSuba", source="trace.moe",
            character_name=None, character_confidence=0.0,
        )

        class Adapter:
            target_name = "senpai_catcher"

            def is_spawn_message(self, event):
                return True

            async def extract_metadata(self, event):
                return metadata

        message = SimpleNamespace(
            id=77,
            chat_id=-1001234567890,
            photo=object(),
            document=None,
            media=SimpleNamespace(__class__=type("MessageMediaPhoto", (), {})),
        )
        event = SimpleNamespace(
            id=77, chat_id=-1001234567890, message=message,
            date=datetime(2026, 11, 13, tzinfo=timezone.utc),
        )

        spawn = await SpawnDetector([Adapter()]).detect(event)

        self.assertEqual(spawn.spawn_context.source, "senpai_catcher")
        self.assertEqual(spawn.spawn_context.chat_id, -1001234567890)
        self.assertEqual(spawn.spawn_context.message_id, 77)
        self.assertEqual(spawn.spawn_context.media_kind, "photo")

    async def test_detector_does_not_fabricate_context_when_chat_id_is_missing(self):
        metadata = SimpleNamespace(
            anime_name="KonoSuba", source="trace.moe",
            character_name=None, character_confidence=0.0,
        )

        class Adapter:
            target_name = "senpai_catcher"
            def is_spawn_message(self, event): return True
            async def extract_metadata(self, event): return metadata

        event = SimpleNamespace(id=78, message=SimpleNamespace(id=78, media=None))
        spawn = await SpawnDetector([Adapter()]).detect(event)

        self.assertIsNone(spawn.spawn_context)
