import json
import tempfile
import unittest
from pathlib import Path

from kagecatch.models.spawn import CharacterMetadata
from kagecatch.character_resolver import CharacterResolver, ResolvedCharacter
from kagecatch.suggestion_formatter import format_character_suggestion


class CharacterResolverTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.mapping = {
            "KonoSuba": ["Megumin", "Aqua", "Darkness"],
            "Re:Zero": ["Emilia", "Rem", "Ram"],
        }
        self.resolver = CharacterResolver(local_mapping=self.mapping)

    async def test_returns_candidates_for_normalized_anime_match(self):
        metadata = CharacterMetadata(
            anime_name="  konosuba  ", source="trace.moe", similarity=0.97
        )
        result = await self.resolver.resolve(metadata)
        self.assertIsInstance(result, ResolvedCharacter)
        self.assertIsNone(result.character_name)
        self.assertEqual(result.candidates, ("Megumin", "Aqua", "Darkness"))
        self.assertEqual(result.source, "local_mapping")
        self.assertLessEqual(result.confidence, 60.0)

    async def test_unknown_anime_returns_none(self):
        metadata = CharacterMetadata(anime_name="Unknown Anime", source="trace.moe")
        self.assertIsNone(await self.resolver.resolve(metadata))

    async def test_missing_anime_name_returns_none(self):
        metadata = CharacterMetadata(anime_name=None, source="trace.moe")
        self.assertIsNone(await self.resolver.resolve(metadata))

    async def test_matching_is_exact_after_normalization_not_substring(self):
        metadata = CharacterMetadata(anime_name="KonoSuba: Another World", source="trace.moe")
        self.assertIsNone(await self.resolver.resolve(metadata))

    async def test_json_mapping_is_loaded_from_explicit_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mapping.json"
            path.write_text(json.dumps({"KonoSuba": ["Megumin"]}), encoding="utf-8")
            resolver = CharacterResolver(mapping_path=path)
            result = await resolver.resolve(
                CharacterMetadata(anime_name="konosuba", source="trace.moe")
            )
        self.assertEqual(result.candidates, ("Megumin",))
        self.assertIsNone(result.character_name)
        self.assertLessEqual(result.confidence, 60.0)

    async def test_empty_candidate_mapping_is_rejected(self):
        with self.assertRaises(ValueError):
            CharacterResolver(local_mapping={"KonoSuba": []})


class SuggestionFormatterTests(unittest.TestCase):
    def test_formats_candidate_buttons_and_ignore_button_without_sending(self):
        resolved = ResolvedCharacter(
            character_name=None,
            candidates=("Megumin", "Aqua"),
            confidence=50.0,
            source="local_mapping",
        )
        message = format_character_suggestion(
            resolved, anime_name="KonoSuba", spawn_id=123
        )
        self.assertIn("KonoSuba", message.text)
        self.assertIn("Which character is it?", message.text)
        labels = [button.text for row in message.inline_keyboard for button in row]
        self.assertEqual(labels, ["Megumin", "Aqua", "Ignore"])
        callback_data = [
            button.callback_data
            for row in message.inline_keyboard
            for button in row
        ]
        self.assertTrue(all(len(value.encode("utf-8")) <= 64 for value in callback_data))
        self.assertTrue(all(value.startswith("kc:s:123:") for value in callback_data))

    def test_escapes_untrusted_anime_title(self):
        resolved = ResolvedCharacter(
            character_name=None, candidates=("Aqua",),
            confidence=50.0, source="local_mapping",
        )
        message = format_character_suggestion(
            resolved, anime_name="<b>Injected</b>", spawn_id=9
        )
        self.assertNotIn("<b>Injected</b>", message.text)
        self.assertIn("&lt;b&gt;Injected&lt;/b&gt;", message.text)

    def test_rejects_empty_candidates(self):
        resolved = ResolvedCharacter(
            character_name=None, candidates=(),
            confidence=0.0, source="local_mapping",
        )
        with self.assertRaises(ValueError):
            format_character_suggestion(resolved, anime_name="KonoSuba", spawn_id=1)


if __name__ == "__main__":
    unittest.main()
