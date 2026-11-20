import unittest

from kagecatch.adapters import TARGETS, build_catch_command


class CatchAdapterConfigTests(unittest.TestCase):
    def test_image_bots_remain_registered_but_disabled(self):
        for source in ("henta_catcher", "character_catcher"):
            self.assertIn(source, TARGETS)
            self.assertFalse(TARGETS[source].enabled)
            with self.assertRaises(RuntimeError):
                build_catch_command(source, "Sakura")

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

    def test_every_catch_target_stays_disabled_until_command_syntax_is_approved(self):
        for source, target in TARGETS.items():
            with self.subTest(source=source):
                self.assertFalse(target.enabled)
                with self.assertRaises(RuntimeError):
                    build_catch_command(source, "Sakura")



if __name__ == "__main__":
    unittest.main()
