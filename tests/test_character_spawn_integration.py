import unittest
from types import SimpleNamespace

from kagecatch.models.spawn import CharacterMetadata
from kagecatch.recognition.character_catalog import (
    CharacterRecognitionResult,
    CharacterRecord,
)
from kagecatch.targets.senpai_catcher import SenpaiCatcherAdapter


class FakeFrameExtractor:
    async def extract_first_frame(self, event):
        return b"jpeg-frame"


class FakeTraceClient:
    def __init__(self, results=None, error=None):
        self.results = results if results is not None else [{
            "anilist": {"title": {"english": "Example Anime"}},
            "episode": 2,
            "similarity": 0.96,
        }]
        self.error = error

    async def search(self, image):
        if self.error:
            raise self.error
        return {"result": self.results}


class FakeCharacterRecognizer:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    async def recognize(self, image, *, media_type):
        self.calls.append((image, media_type))
        if self.error:
            raise self.error
        return self.result


class CharacterRecognitionSpawnIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def _adapter(self, recognizer=None, trace_results=None, trace_error=None):
        return SenpaiCatcherAdapter(
            sender_id=123,
            frame_extractor=FakeFrameExtractor(),
            trace_client=FakeTraceClient(trace_results, trace_error),
            character_recognizer=recognizer,
        )

    async def test_known_catalog_result_is_attached_to_spawn_metadata(self):
        record = CharacterRecord(
            "sakura-001", "Sakura", "Example Anime", aliases=("Sakura Haruno",)
        )
        recognizer = FakeCharacterRecognizer(
            CharacterRecognitionResult(
                status="known", character=record, confidence=0.94
            )
        )
        adapter = self._adapter(recognizer)

        metadata = await adapter.extract_metadata(
            SimpleNamespace(sender_id=123, id=77, video=b"video",
                            raw_text="A New Character Has Appeared!")
        )

        self.assertIsInstance(metadata, CharacterMetadata)
        self.assertEqual(metadata.source, "senpai_catcher")
        self.assertEqual(metadata.character_name, "Sakura")
        self.assertEqual(metadata.character_confidence, 0.94)
        self.assertEqual(metadata.anime_name, "Example Anime")
        self.assertEqual(recognizer.calls, [(b"jpeg-frame", "image/jpeg")])

    async def test_review_result_never_promotes_proposed_name_to_identity(self):
        recognizer = FakeCharacterRecognizer(
            CharacterRecognitionResult(
                status="review", character=None, confidence=0.91,
                proposed_name="Unverified Name", reason="ambiguous_candidates"
            )
        )
        metadata = await self._adapter(recognizer).extract_metadata(
            SimpleNamespace(sender_id=123, id=77, video=b"video",
                            raw_text="A New Character Has Appeared!")
        )

        self.assertIsNone(metadata.character_name)
        self.assertEqual(metadata.character_confidence, 0.0)
        self.assertEqual(metadata.source, "senpai_catcher")

    async def test_unknown_result_does_not_become_catchable_identity(self):
        recognizer = FakeCharacterRecognizer(
            CharacterRecognitionResult(
                status="unknown", character=None, confidence=0.99,
                proposed_name="Uncatalogued", reason="not_in_catalog"
            )
        )
        metadata = await self._adapter(recognizer).extract_metadata(
            SimpleNamespace(sender_id=123, id=77, video=b"video",
                            raw_text="A New Character Has Appeared!")
        )

        self.assertIsNone(metadata.character_name)
        self.assertEqual(metadata.character_confidence, 0.0)

    async def test_model_failure_keeps_anime_metadata_but_fails_character_closed(self):
        recognizer = FakeCharacterRecognizer(error=RuntimeError("provider unavailable"))
        metadata = await self._adapter(recognizer).extract_metadata(
            SimpleNamespace(sender_id=123, id=77, video=b"video",
                            raw_text="A New Character Has Appeared!")
        )

        self.assertEqual(metadata.anime_name, "Example Anime")
        self.assertIsNone(metadata.character_name)
        self.assertEqual(metadata.character_confidence, 0.0)

    async def test_character_recognition_runs_even_when_scene_lookup_has_no_match(self):
        record = CharacterRecord("sakura-001", "Sakura", "Example Anime")
        recognizer = FakeCharacterRecognizer(
            CharacterRecognitionResult(status="known", character=record, confidence=0.93)
        )
        metadata = await self._adapter(recognizer, trace_results=[]).extract_metadata(
            SimpleNamespace(sender_id=123, id=77, video=b"video",
                            raw_text="A New Character Has Appeared!")
        )

        self.assertIsNone(metadata.anime_name)
        self.assertEqual(metadata.character_name, "Sakura")
        self.assertEqual(metadata.character_confidence, 0.93)
        self.assertEqual(metadata.source, "senpai_catcher")
        self.assertEqual(recognizer.calls, [(b"jpeg-frame", "image/jpeg")])

    async def test_character_recognition_survives_trace_moe_network_failure(self):
        record = CharacterRecord("sakura-001", "Sakura", "Example Anime")
        recognizer = FakeCharacterRecognizer(
            CharacterRecognitionResult(status="known", character=record, confidence=0.93)
        )
        metadata = await self._adapter(
            recognizer, trace_error=TimeoutError("trace.moe unavailable")
        ).extract_metadata(
            SimpleNamespace(sender_id=123, id=77, video=b"video",
                            raw_text="A New Character Has Appeared!")
        )

        self.assertIsNone(metadata.anime_name)
        self.assertEqual(metadata.character_name, "Sakura")
        self.assertEqual(metadata.character_confidence, 0.93)
        self.assertEqual(metadata.additional["scene_lookup_status"], "unavailable")

    async def test_without_character_recognizer_does_not_invent_identity(self):
        metadata = await self._adapter().extract_metadata(
            SimpleNamespace(sender_id=123, id=77, video=b"video",
                            raw_text="A New Character Has Appeared!")
        )

        self.assertIsNone(metadata.character_name)
        self.assertEqual(metadata.character_confidence, 0.0)
        self.assertEqual(metadata.source, "senpai_catcher")


if __name__ == "__main__":
    unittest.main()
