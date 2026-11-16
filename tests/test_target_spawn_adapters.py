import unittest
from types import SimpleNamespace

from kagecatch.targets.hentai_catcher import HentaiCatcherAdapter
from kagecatch.targets.catcher import CatcherAdapter


def event(text, *, photo=True, video=False, sender_id=101):
    message = SimpleNamespace(
        id=55, chat_id=-100123, message=text,
        photo=object() if photo else None,
        video=object() if video else None, media=None,
    )
    return SimpleNamespace(message=message, sender_id=sender_id, chat_id=-100123)


class HentaiCatcherAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.adapter = HentaiCatcherAdapter(sender_id=101)

    async def test_recognizes_new_character_spawn_photo_caption(self):
        sample = event(
            "✦ NEW CHARACTER SPAWN ✦\nA new character has appeared!\n"
            "Use /catch Name to claim.\nYou have 90 seconds before escape!"
        )
        self.assertTrue(self.adapter.is_spawn_message(sample))

    async def test_rejects_wrong_sender_even_when_caption_matches(self):
        self.assertFalse(self.adapter.is_spawn_message(event(
            "NEW CHARACTER SPAWN — Use /catch Name", sender_id=999
        )))

    async def test_rejects_unrelated_message(self):
        self.assertFalse(self.adapter.is_spawn_message(event("hello")))

    async def test_metadata_does_not_invent_character_identity(self):
        metadata = await self.adapter.extract_metadata(event("NEW CHARACTER SPAWN"))
        self.assertIsNone(metadata.character_name)
        self.assertEqual(metadata.character_confidence, 0.0)
        self.assertEqual(metadata.source, "hentai_catcher")


class CatcherAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.adapter = CatcherAdapter(sender_id=202)

    async def test_recognizes_chat_spawn_photo_caption(self):
        sample = event(
            "🎁 A CHARACTER HAS SPAWNED IN THE CHAT!\n"
            "ADD THIS CHARACTER TO YOUR HAREM USING /catch [NAME]",
            sender_id=202,
        )
        self.assertTrue(self.adapter.is_spawn_message(sample))

    async def test_rejects_wrong_sender(self):
        self.assertFalse(self.adapter.is_spawn_message(event(
            "A CHARACTER HAS SPAWNED IN THE CHAT! /catch [NAME]",
            sender_id=999,
        )))

    async def test_rejects_missing_media(self):
        sample = event(
            "A CHARACTER HAS SPAWNED IN THE CHAT! /catch [NAME]",
            photo=False, sender_id=202,
        )
        self.assertFalse(self.adapter.is_spawn_message(sample))

    async def test_metadata_does_not_invent_character_identity(self):
        metadata = await self.adapter.extract_metadata(event(
            "A CHARACTER HAS SPAWNED IN THE CHAT! /catch [NAME]",
            sender_id=202,
        ))
        self.assertIsNone(metadata.character_name)
        self.assertEqual(metadata.character_confidence, 0.0)
        self.assertEqual(metadata.source, "catcher")


if __name__ == "__main__":
    unittest.main()
