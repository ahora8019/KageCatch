import unittest

from kagecatch.recognition.character_catalog import (
    CharacterCatalog,
    CharacterRecord,
    CharacterRecognitionEngine,
    RecognitionCandidate,
)
from kagecatch.recognition.model_adapter import CharacterModelAdapter


class FakeVisionModel:
    def __init__(self, candidates=None, error=None):
        self.candidates = candidates if candidates is not None else []
        self.error = error
        self.calls = []

    async def predict(self, image: bytes, *, media_type: str):
        self.calls.append((image, media_type))
        if self.error is not None:
            raise self.error
        return self.candidates


class CharacterModelAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        catalog = CharacterCatalog([
            CharacterRecord("sakura-001", "Sakura", "Example Anime"),
        ])
        self.engine = CharacterRecognitionEngine(catalog, confidence_threshold=0.85)

    async def test_routes_model_candidates_through_catalog_confidence_gate(self):
        model = FakeVisionModel([
            RecognitionCandidate("Sakura", 0.94),
        ])
        adapter = CharacterModelAdapter(self.engine, model)

        result = await adapter.recognize(b"image-bytes", media_type="image/jpeg")

        self.assertEqual(result.status, "known")
        self.assertEqual(result.character.character_id, "sakura-001")
        self.assertEqual(model.calls, [(b"image-bytes", "image/jpeg")])

    async def test_low_confidence_model_output_stays_in_review(self):
        model = FakeVisionModel([
            RecognitionCandidate("Sakura", 0.4),
        ])
        adapter = CharacterModelAdapter(self.engine, model)

        result = await adapter.recognize(b"image-bytes", media_type="image/png")

        self.assertEqual(result.status, "review")
        self.assertEqual(result.reason, "low_confidence")

    async def test_model_failure_fails_closed_without_exposing_exception(self):
        model = FakeVisionModel(error=RuntimeError("private provider detail"))
        adapter = CharacterModelAdapter(self.engine, model)

        result = await adapter.recognize(b"image-bytes", media_type="image/jpeg")

        self.assertEqual(result.status, "review")
        self.assertEqual(result.reason, "model_unavailable")
        self.assertNotIn("private provider detail", repr(result))

    async def test_rejects_empty_image_before_calling_model(self):
        model = FakeVisionModel([RecognitionCandidate("Sakura", 0.99)])
        adapter = CharacterModelAdapter(self.engine, model)

        result = await adapter.recognize(b"", media_type="image/jpeg")

        self.assertEqual(result.status, "review")
        self.assertEqual(result.reason, "invalid_image")
        self.assertEqual(model.calls, [])

    async def test_rejects_unsupported_media_type_before_calling_model(self):
        model = FakeVisionModel([RecognitionCandidate("Sakura", 0.99)])
        adapter = CharacterModelAdapter(self.engine, model)

        result = await adapter.recognize(b"image-bytes", media_type="application/octet-stream")

        self.assertEqual(result.status, "review")
        self.assertEqual(result.reason, "unsupported_media_type")
        self.assertEqual(model.calls, [])

    async def test_rejects_images_over_configured_byte_limit(self):
        model = FakeVisionModel([RecognitionCandidate("Sakura", 0.99)])
        adapter = CharacterModelAdapter(self.engine, model, max_image_bytes=4)

        result = await adapter.recognize(b"12345", media_type="image/jpeg")

        self.assertEqual(result.status, "review")
        self.assertEqual(result.reason, "image_too_large")
        self.assertEqual(model.calls, [])

    async def test_invalid_model_output_fails_closed(self):
        model = FakeVisionModel(None)
        adapter = CharacterModelAdapter(self.engine, model)

        result = await adapter.recognize(b"image-bytes", media_type="image/webp")

        self.assertEqual(result.status, "review")
        self.assertEqual(result.reason, "invalid_model_output")

    async def test_rejects_invalid_image_limit_configuration(self):
        model = FakeVisionModel()
        with self.assertRaises(ValueError):
            CharacterModelAdapter(self.engine, model, max_image_bytes=True)


if __name__ == "__main__":
    unittest.main()
