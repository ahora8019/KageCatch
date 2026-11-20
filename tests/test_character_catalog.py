import unittest

from kagecatch.recognition.character_catalog import (
    CharacterCatalog,
    CharacterRecord,
    CharacterRecognitionEngine,
    RecognitionCandidate,
)


class CharacterCatalogTests(unittest.TestCase):
    def setUp(self):
        self.catalog = CharacterCatalog([
            CharacterRecord(
                character_id="sakura-001",
                canonical_name="Sakura",
                anime_name="Example Anime",
                aliases=("春野サクラ", "Haruno Sakura"),
            ),
            CharacterRecord(
                character_id="rei-001",
                canonical_name="Rei",
                anime_name="Example Anime",
                aliases=("Ayanami Rei",),
            ),
        ])

    def test_resolves_canonical_name_and_alias_case_insensitively(self):
        self.assertEqual(self.catalog.resolve("sAkUrA").character_id, "sakura-001")
        self.assertEqual(self.catalog.resolve("HARUNO SAKURA").character_id, "sakura-001")
        self.assertEqual(self.catalog.resolve("春野サクラ").character_id, "sakura-001")

    def test_rejects_duplicate_aliases_across_characters(self):
        with self.assertRaises(ValueError):
            CharacterCatalog([
                CharacterRecord("one", "Sakura", "Anime A", aliases=("same",)),
                CharacterRecord("two", "Rei", "Anime B", aliases=(" SAME ",)),
            ])

    def test_rejects_invalid_confidence_threshold(self):
        with self.assertRaises(ValueError):
            CharacterRecognitionEngine(self.catalog, confidence_threshold=1.1)

    def test_returns_known_only_when_catalog_match_is_confident(self):
        engine = CharacterRecognitionEngine(self.catalog, confidence_threshold=0.85)
        result = engine.recognize([
            RecognitionCandidate(name="Haruno Sakura", confidence=0.93)
        ])
        self.assertEqual(result.status, "known")
        self.assertEqual(result.character.character_id, "sakura-001")
        self.assertEqual(result.confidence, 0.93)

    def test_low_confidence_known_candidate_requires_review(self):
        engine = CharacterRecognitionEngine(self.catalog, confidence_threshold=0.85)
        result = engine.recognize([
            RecognitionCandidate(name="Sakura", confidence=0.61)
        ])
        self.assertEqual(result.status, "review")
        self.assertIsNone(result.character)

    def test_unknown_high_confidence_candidate_is_not_misidentified(self):
        engine = CharacterRecognitionEngine(self.catalog, confidence_threshold=0.85)
        result = engine.recognize([
            RecognitionCandidate(name="New Character", confidence=0.98)
        ])
        self.assertEqual(result.status, "unknown")
        self.assertIsNone(result.character)
        self.assertEqual(result.proposed_name, "New Character")

    def test_empty_candidates_require_review_without_guessing(self):
        engine = CharacterRecognitionEngine(self.catalog)
        result = engine.recognize([])
        self.assertEqual(result.status, "review")
        self.assertIsNone(result.character)

    def test_ambiguous_top_candidates_require_review(self):
        engine = CharacterRecognitionEngine(
            self.catalog, confidence_threshold=0.8, min_margin=0.1
        )
        result = engine.recognize([
            RecognitionCandidate(name="Sakura", confidence=0.91),
            RecognitionCandidate(name="Rei", confidence=0.88),
        ])
        self.assertEqual(result.status, "review")
        self.assertIsNone(result.character)


    def test_alias_candidates_for_same_character_are_not_ambiguous(self):
        engine = CharacterRecognitionEngine(
            self.catalog, confidence_threshold=0.8, min_margin=0.1
        )
        result = engine.recognize([
            RecognitionCandidate(name="Sakura", confidence=0.92),
            RecognitionCandidate(name="Haruno Sakura", confidence=0.89),
        ])
        self.assertEqual(result.status, "known")
        self.assertEqual(result.character.character_id, "sakura-001")


    def test_rejects_candidate_stream_larger_than_configured_limit(self):
        engine = CharacterRecognitionEngine(self.catalog, max_candidates=3)
        consumed = []

        def candidates():
            for index in range(1000):
                consumed.append(index)
                yield RecognitionCandidate(name=f"Candidate {index}", confidence=0.9)

        with self.assertRaisesRegex(ValueError, "at most 3 candidates"):
            engine.recognize(candidates())
        self.assertEqual(consumed, [0, 1, 2, 3])


if __name__ == "__main__":
    unittest.main()
