import unittest

from kagecatch.adapters import TARGETS, build_catch_command


class CatchAdapterConfigTests(unittest.TestCase):
    def test_image_bots_use_catch_command(self):
        self.assertEqual(build_catch_command("henta_catcher", "Sakura"), "/catch Sakura")
        self.assertEqual(build_catch_command("character_catcher", "Sakura"), "/catch Sakura")

    def test_senpai_remains_registered_but_frozen(self):
        self.assertIn("senpai_catcher", TARGETS)
        self.assertFalse(TARGETS["senpai_catcher"].enabled)
        with self.assertRaises(RuntimeError):
            build_catch_command("senpai_catcher", "Sakura")

    def test_unknown_source_is_rejected(self):
        with self.assertRaises(ValueError):
            build_catch_command("unknown", "Sakura")

    def test_newline_in_character_name_is_rejected(self):
        with self.assertRaises(ValueError):
            build_catch_command("henta_catcher", "Sakura\n/start")


if __name__ == "__main__":
    unittest.main()
