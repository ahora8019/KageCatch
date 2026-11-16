import unittest

from kagecatch.visual_recognition import VisualRecognitionResolver


class FakeVisionClient:
    def __init__(self, result=None, error=None):
        self.result, self.error = result, error

    async def recognize(self, image: bytes):
        if self.error:
            raise self.error
        return self.result


class VisualRecognitionResolverTests(unittest.IsolatedAsyncioTestCase):
    async def test_normalizes_anime_and_character_candidates_without_auto_selecting(self):
        resolver = VisualRecognitionResolver(FakeVisionClient({
            "anime_name": "Fixture Anime",
            "anime_confidence": 0.91,
            "character_candidates": [
                {"name": "Character A", "confidence": 0.83},
                {"name": "Character B", "confidence": 0.62},
            ],
        }))
        result = await resolver.resolve(b"fixture-image")
        self.assertEqual(result.anime_name, "Fixture Anime")
        self.assertEqual(result.source, "visual_recognition")
        self.assertIsNone(result.character_name)
        self.assertEqual(result.character_confidence, 0.0)
        self.assertEqual(
            result.additional["character_candidates"],
            (("Character A", 0.83), ("Character B", 0.62)),
        )

    async def test_rejects_empty_or_oversized_image(self):
        resolver = VisualRecognitionResolver(FakeVisionClient({}), max_image_bytes=8)
        with self.assertRaises(ValueError):
            await resolver.resolve(b"")
        with self.assertRaises(ValueError):
            await resolver.resolve(b"123456789")

    async def test_rejects_malformed_provider_payload(self):
        resolver = VisualRecognitionResolver(FakeVisionClient({"character_candidates": "not-list"}))
        with self.assertRaises(ValueError):
            await resolver.resolve(b"image")

    async def test_filters_invalid_candidates_and_caps_candidate_count(self):
        resolver = VisualRecognitionResolver(FakeVisionClient({
            "anime_name": "Anime",
            "anime_confidence": 1.2,
            "character_candidates": [
                {"name": "A", "confidence": 0.9},
                {"name": "", "confidence": 0.8},
                {"name": "B", "confidence": 0.7},
                {"name": "C", "confidence": 0.6},
                {"name": "D", "confidence": 0.5},
                {"name": "E", "confidence": 0.4},
                {"name": "F", "confidence": 0.3},
            ],
        }), max_candidates=3)
        result = await resolver.resolve(b"image")
        self.assertIsNone(result.anime_confidence)
        self.assertEqual(
            tuple(name for name, _ in result.additional["character_candidates"]),
            ("A", "B", "C"),
        )

    async def test_provider_error_does_not_leak_provider_details(self):
        resolver = VisualRecognitionResolver(FakeVisionClient(error=RuntimeError("secret payload")))
        with self.assertRaisesRegex(RuntimeError, "visual recognition failed"):
            await resolver.resolve(b"image")


if __name__ == "__main__":
    unittest.main()
