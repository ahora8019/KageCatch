import json
import unittest

import httpx

from kagecatch.recognition.character_catalog import (
    CharacterCatalog,
    CharacterRecord,
    CharacterRecognitionEngine,
    RecognitionCandidate,
)
from kagecatch.recognition.model_adapter import CharacterModelAdapter
from kagecatch.recognition.cloudflare_workers_ai import (
    CloudflareWorkersAIVisionModel,
    VisionModelProviderError,
)


ACCOUNT_ID = "a" * 32
API_TOKEN = "test-secret-token"


class CloudflareWorkersAIVisionModelTests(unittest.IsolatedAsyncioTestCase):
    async def test_sends_image_and_returns_review_only_candidate(self):
        captured = {}

        async def handler(request):
            captured["url"] = str(request.url)
            captured["authorization"] = request.headers.get("authorization")
            captured["payload"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={"success": True, "result": {
                    "response": '{"character_name":"Sakura"}'
                }},
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        model = CloudflareWorkersAIVisionModel(
            ACCOUNT_ID, API_TOKEN, client=client
        )
        try:
            candidates = await model.predict(b"jpeg-bytes", media_type="image/jpeg")
        finally:
            await client.aclose()

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].name, "Sakura")
        self.assertEqual(candidates[0].confidence, 0.5)
        self.assertTrue(model.requires_human_review)
        self.assertIn("/ai/run/@cf/meta/llama-4-scout-17b-16e-instruct", captured["url"])
        self.assertEqual(captured["authorization"], f"Bearer {API_TOKEN}")
        message = captured["payload"]["messages"][0]
        image_part = message["content"][1]
        self.assertEqual(image_part["type"], "image_url")
        self.assertTrue(image_part["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(captured["payload"]["temperature"], 0)
        self.assertEqual(
            captured["payload"]["guided_json"]["required"],
            ["character_name"],
        )

    async def test_null_character_name_returns_no_candidates(self):
        async def handler(request):
            return httpx.Response(
                200,
                json={"success": True, "result": {"response": '{"character_name":null}'}},
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        model = CloudflareWorkersAIVisionModel(ACCOUNT_ID, API_TOKEN, client=client)
        try:
            candidates = await model.predict(b"jpeg-bytes", media_type="image/jpeg")
        finally:
            await client.aclose()
        self.assertEqual(candidates, [])

    async def test_malformed_model_json_fails_closed(self):
        async def handler(request):
            return httpx.Response(
                200,
                json={"success": True, "result": {"response": "Sakura is visible"}},
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        model = CloudflareWorkersAIVisionModel(ACCOUNT_ID, API_TOKEN, client=client)
        try:
            with self.assertRaises(VisionModelProviderError):
                await model.predict(b"jpeg-bytes", media_type="image/jpeg")
        finally:
            await client.aclose()

    async def test_rejects_invalid_input_before_network_request(self):
        called = False

        async def handler(request):
            nonlocal called
            called = True
            return httpx.Response(200, json={})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        model = CloudflareWorkersAIVisionModel(ACCOUNT_ID, API_TOKEN, client=client)
        try:
            with self.assertRaises(ValueError):
                await model.predict(b"", media_type="image/jpeg")
            with self.assertRaises(ValueError):
                await model.predict(b"jpeg-bytes", media_type="image/gif")
        finally:
            await client.aclose()
        self.assertFalse(called)

    async def test_does_not_expose_token_when_provider_request_fails(self):
        async def handler(request):
            return httpx.Response(401, json={"errors": [{"message": "unauthorized"}]})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        model = CloudflareWorkersAIVisionModel(ACCOUNT_ID, API_TOKEN, client=client)
        try:
            with self.assertRaises(VisionModelProviderError) as caught:
                await model.predict(b"jpeg-bytes", media_type="image/jpeg")
        finally:
            await client.aclose()
        self.assertNotIn(API_TOKEN, str(caught.exception))


class AlwaysReviewAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_known_candidate_is_downgraded_to_human_review(self):
        class Model:
            requires_human_review = True

            async def predict(self, image, *, media_type):
                return [RecognitionCandidate("Sakura", 0.99)]

        engine = CharacterRecognitionEngine(
            CharacterCatalog([CharacterRecord("sakura-001", "Sakura", "Example Anime")])
        )
        result = await CharacterModelAdapter(engine, Model()).recognize(
            b"jpeg-bytes", media_type="image/jpeg"
        )
        self.assertEqual(result.status, "review")
        self.assertIsNone(result.character)
        self.assertEqual(result.proposed_name, "Sakura")
        self.assertEqual(result.reason, "model_requires_human_review")

    async def test_unknown_candidate_is_also_downgraded_to_human_review(self):
        class Model:
            requires_human_review = True

            async def predict(self, image, *, media_type):
                return [RecognitionCandidate("Uncatalogued", 0.99)]

        engine = CharacterRecognitionEngine(CharacterCatalog())
        result = await CharacterModelAdapter(engine, Model()).recognize(
            b"jpeg-bytes", media_type="image/jpeg"
        )
        self.assertEqual(result.status, "review")
        self.assertEqual(result.proposed_name, "Uncatalogued")
        self.assertEqual(result.reason, "model_requires_human_review")


if __name__ == "__main__":
    unittest.main()
