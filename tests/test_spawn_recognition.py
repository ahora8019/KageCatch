import unittest
from datetime import datetime, timezone

from kagecatch.targets.senpai_catcher import SenpaiCatcherAdapter
from kagecatch.models.spawn import CharacterMetadata, SpawnEvent
from kagecatch.spawn_detector import SpawnDetector


class FakeEvent:
    def __init__(self, *, sender_id=123, sender_username="SenpaiCatcherBot",
                 text="A New Character Has Appeared!", video=b"video",
                 message_id=77, date=None):
        self.sender_id = sender_id
        self.sender_username = sender_username
        self.raw_text = text
        self.video = video
        self.id = message_id
        self.date = date


class FakeFrameExtractor:
    async def extract_first_frame(self, video):
        if video == b"bad-video":
            raise ValueError("frame extraction failed")
        return b"jpeg-frame"


class FakeTraceClient:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    async def search(self, image):
        self.calls.append(image)
        if self.error:
            raise self.error
        return self.result


def trace_response(*, character=False):
    return {
        "result": [{
            "anilist": {
                "id": 1,
                "title": {"romaji": "Example Anime", "english": "Example Anime"},
                **({"character": {"name": {"full": "Not a real assertion"}}} if character else {}),
            },
            "episode": 3,
            "similarity": 0.97,
            "from": 12.5,
            "to": 14.0,
        }]
    }


class OtherAdapter:
    target_name = "other"

    def __init__(self, recognizes=False, metadata=None, error=None):
        self.recognizes = recognizes
        self.metadata = metadata
        self.error = error

    def is_spawn_message(self, event):
        return self.recognizes

    async def extract_metadata(self, event):
        if self.error:
            raise self.error
        return self.metadata

    def get_catch_command(self, character_name):
        return f"/catch {character_name}"


class SenpaiAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.trace = FakeTraceClient(trace_response())
        self.adapter = SenpaiCatcherAdapter(
            sender_id=123,
            frame_extractor=FakeFrameExtractor(),
            trace_client=self.trace,
        )

    async def test_recognizes_configured_sender_video_and_exact_phrase(self):
        self.assertTrue(self.adapter.is_spawn_message(FakeEvent()))

    async def test_rejects_wrong_sender(self):
        self.assertFalse(self.adapter.is_spawn_message(FakeEvent(sender_id=999)))

    async def test_rejects_missing_video(self):
        self.assertFalse(self.adapter.is_spawn_message(FakeEvent(video=None)))

    async def test_rejects_incorrect_spawn_text(self):
        self.assertFalse(self.adapter.is_spawn_message(FakeEvent(text="A character appeared!")))

    async def test_trace_match_does_not_fabricate_character_name(self):
        metadata = await self.adapter.extract_metadata(FakeEvent())
        self.assertIsInstance(metadata, CharacterMetadata)
        self.assertEqual(metadata.anime_name, "Example Anime")
        self.assertEqual(metadata.episode, 3)
        self.assertAlmostEqual(metadata.similarity, 0.97)
        self.assertIsNone(metadata.character_name)
        self.assertEqual(metadata.character_confidence, 0.0)
        self.assertEqual(self.trace.calls, [b"jpeg-frame"])

    async def test_api_timeout_is_reported_as_metadata_error(self):
        adapter = SenpaiCatcherAdapter(
            sender_id=123,
            frame_extractor=FakeFrameExtractor(),
            trace_client=FakeTraceClient(error=TimeoutError("timeout")),
        )
        from kagecatch.targets.senpai_catcher import MetadataLookupError
        with self.assertRaises(MetadataLookupError):
            await adapter.extract_metadata(FakeEvent())

    async def test_http_failure_is_converted_to_metadata_error(self):
        import httpx
        from kagecatch.targets.senpai_catcher import HttpxTraceMoeClient, MetadataLookupError

        def respond(request):
            return httpx.Response(503, request=request)

        client = HttpxTraceMoeClient(transport=httpx.MockTransport(respond))
        with self.assertRaises(MetadataLookupError):
            await client.search(b"jpeg-frame")

    async def test_invalid_api_response_is_rejected(self):
        adapter = SenpaiCatcherAdapter(
            sender_id=123,
            frame_extractor=FakeFrameExtractor(),
            trace_client=FakeTraceClient(result={"result": "not-a-list"}),
        )
        from kagecatch.targets.senpai_catcher import MetadataLookupError
        with self.assertRaises(MetadataLookupError):
            await adapter.extract_metadata(FakeEvent())

    async def test_catch_command_uses_documented_pick_format(self):
        self.assertEqual(self.adapter.get_catch_command("Sakura"), "/pick Sakura")


class SpawnDetectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_first_recognizing_adapter_and_returns_spawn_event(self):
        metadata = CharacterMetadata(
            anime_name="Example Anime",
            character_name=None,
            similarity=0.96,
            source="trace.moe",
            character_confidence=0.0,
        )
        detector = SpawnDetector([OtherAdapter(), OtherAdapter(True, metadata)])
        event = FakeEvent(date=datetime(2026, 1, 1, tzinfo=timezone.utc))
        result = await detector.detect(event)
        self.assertIsInstance(result, SpawnEvent)
        self.assertEqual(result.message_id, 77)
        self.assertIsNone(result.character_name)
        self.assertEqual(result.confidence_score, 0.0)
        self.assertEqual(result.target_name, "other")

    async def test_adapter_failure_does_not_block_later_adapters(self):
        metadata = CharacterMetadata(
            anime_name="Example Anime",
            source="trace.moe",
            character_confidence=0.0,
        )
        detector = SpawnDetector([
            OtherAdapter(True, error=RuntimeError("broken adapter")),
            OtherAdapter(True, metadata),
        ])
        result = await detector.detect(FakeEvent())
        self.assertIsNotNone(result)
        self.assertEqual(result.target_name, "other")

    async def test_returns_none_when_no_adapter_recognizes_event(self):
        detector = SpawnDetector([OtherAdapter(False)])
        self.assertIsNone(await detector.detect(FakeEvent()))


if __name__ == "__main__":
    unittest.main()
