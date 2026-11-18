import unittest
from types import SimpleNamespace

from kagecatch.targets.registry import build_default_target_adapters


class DefaultTargetRegistryTests(unittest.TestCase):
    def setUp(self):
        self.adapters = build_default_target_adapters()

    def event(self, username, text, *, photo=False, video=False):
        message = SimpleNamespace(
            id=77, chat_id=-100123, message=text,
            photo=object() if photo else None,
            video=object() if video else None,
            media=None,
        )
        sender = SimpleNamespace(username=username)
        return SimpleNamespace(
            message=message, sender=sender, sender_id=None,
            sender_username=username, chat_id=-100123,
        )

    def test_registry_contains_exactly_the_three_configured_sources(self):
        self.assertEqual(
            set(self.adapters),
            {"catcher", "hentai_catcher", "senpai_catcher"},
        )

    def test_character_catcher_username_routes_to_catcher_adapter(self):
        adapter = self.adapters["catcher"]
        self.assertTrue(adapter.is_spawn_message(self.event(
            "Character_Catcher_Bot",
            "🎁 A CHARACTER HAS SPAWNED IN THE CHAT! /catch [NAME]",
            photo=True,
        )))

    def test_henta_catcher_username_routes_to_hentai_adapter(self):
        adapter = self.adapters["hentai_catcher"]
        self.assertTrue(adapter.is_spawn_message(self.event(
            "HentaCatcherBot",
            "✦ NEW CHARACTER SPAWN ✦ A new character has appeared! "
            "Use /catch Name to claim. You have 90 seconds before escape!",
            photo=True,
        )))

    def test_senpai_username_routes_to_video_adapter(self):
        adapter = self.adapters["senpai_catcher"]
        self.assertTrue(adapter.is_spawn_message(self.event(
            "SenpaiCatcherBot",
            "A New Character Has Appeared! Who is this character? Use /pick",
            video=True,
        )))

    def test_wrong_source_cannot_trigger_another_adapter(self):
        event = self.event(
            "SenpaiCatcherBot",
            "🎁 A CHARACTER HAS SPAWNED IN THE CHAT! /catch [NAME]",
            photo=True,
        )
        self.assertFalse(self.adapters["catcher"].is_spawn_message(event))


if __name__ == "__main__":
    unittest.main()
