import base64
import hashlib
import hmac
import json
import unittest
from datetime import datetime, timedelta, timezone

import httpx

from kagecatch.d1_manual_review_store import D1ManualReviewStore


SECRET = "test-secret-with-at-least-thirty-two-bytes"
BASE_URL = "https://control.example.test"


class D1ManualReviewStoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_create_sends_serialized_review_over_signed_internal_api(self):
        observed = {}

        async def handler(request):
            observed["request"] = request
            return httpx.Response(201, json={"status": "created"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            store = D1ManualReviewStore(
                BASE_URL, SECRET, client=client,
                clock=lambda: 1794140000,
                nonce_factory=lambda: "a" * 32,
            )
            await store.create({
                "review_id": "b" * 32,
                "user_id": "12345",
                "spawn_id": 77,
                "anime_name": "KonoSuba",
                "candidates": ["Megumin", "Aqua"],
                "created_at": "2026-11-08T12:00:00+00:00",
                "expires_at": "2026-11-08T12:15:00+00:00",
            })

        request = observed["request"]
        body = request.content
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.url.path, "/internal/manual-review")
        self.assertEqual(json.loads(body)["action"], "create")
        timestamp = request.headers["X-KageCatch-Timestamp"]
        nonce = request.headers["X-KageCatch-Nonce"]
        expected_text = "\n".join([
            timestamp, nonce, "POST", "/internal/manual-review",
            hashlib.sha256(body).hexdigest(),
        ])
        expected = hmac.new(SECRET.encode(), expected_text.encode(), hashlib.sha256).hexdigest()
        self.assertTrue(hmac.compare_digest(expected, request.headers["X-KageCatch-Signature"]))

    async def test_list_pending_decodes_records_and_is_user_scoped(self):
        async def handler(request):
            payload = json.loads(request.content)
            self.assertEqual(payload, {"action": "list", "user_id": "12345"})
            return httpx.Response(200, json={"items": [{
                "review_id": "a" * 32,
                "user_id": "12345",
                "spawn_id": 7,
                "anime_name": "KonoSuba",
                "candidates": ["Megumin"],
                "created_at": "2026-11-08T12:00:00+00:00",
                "expires_at": "2026-11-08T12:15:00+00:00",
                "status": "pending",
                "selected_character": None,
            }]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            store = D1ManualReviewStore(BASE_URL, SECRET, client=client)
            items = await store.list_pending("12345")

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["candidates"], ["Megumin"])

    async def test_resolve_uses_conditional_action_and_returns_updated_record(self):
        async def handler(request):
            payload = json.loads(request.content)
            self.assertEqual(payload, {
                "action": "approve", "user_id": "12345",
                "review_id": "a" * 32, "candidate_index": 0,
            })
            return httpx.Response(200, json={"item": {
                "review_id": "a" * 32, "user_id": "12345",
                "spawn_id": 7, "anime_name": "KonoSuba",
                "candidates": ["Megumin"], "created_at": "2026-11-08T12:00:00+00:00",
                "expires_at": "2026-11-08T12:15:00+00:00",
                "status": "approved", "selected_character": "Megumin",
            }})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            store = D1ManualReviewStore(BASE_URL, SECRET, client=client)
            result = await store.resolve(
                user_id="12345", review_id="a" * 32,
                action="approve", candidate_index=0,
            )

        self.assertEqual(result["status"], "approved")
        self.assertEqual(result["selected_character"], "Megumin")

    async def test_expire_returns_number_of_newly_expired_items(self):
        async def handler(request):
            self.assertEqual(json.loads(request.content), {"action": "expire"})
            return httpx.Response(200, json={"expired": 3})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            store = D1ManualReviewStore(BASE_URL, SECRET, client=client)
            self.assertEqual(await store.expire(), 3)


    async def test_allows_plain_http_only_for_loopback_wrangler_dev(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"items": []})
        )) as client:
            store = D1ManualReviewStore(
                "http://127.0.0.1:8787", SECRET, client=client
            )
            self.assertEqual(store._base_url, "http://127.0.0.1:8787")
            self.assertEqual(await store.list_pending("12345"), [])

    async def test_rejects_non_https_url_and_short_secret(self):
        with self.assertRaises(ValueError):
            D1ManualReviewStore("http://control.example.test", SECRET)
        with self.assertRaises(ValueError):
            D1ManualReviewStore(BASE_URL, "short")


if __name__ == "__main__":
    unittest.main()
