import hashlib
import hmac
import json
import unittest

import httpx

from kagecatch.d1_telegram_safety import D1TelegramSafetyClient


class D1TelegramSafetyClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.secret = "test-d1-telegram-safety-secret-at-least-32-bytes"
        async def handler(request):
            body = await request.aread()
            self.requests.append((request, body))
            if request.url.path.endswith("/reserve"):
                return httpx.Response(200, json={"allowed": True, "nextAllowedAt": 200})
            if request.url.path.endswith("/backoff"):
                return httpx.Response(200, json={"updated": True})
            if request.url.path.endswith("/lock"):
                return httpx.Response(200, json={"updated": True, "locked": True, "reason": "manual_review"})
            return httpx.Response(404, json={"error": "not_found"})
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = D1TelegramSafetyClient(
            "https://kagecatch-control.example",
            self.secret,
            client=self.http,
            clock=lambda: 1_800_000_000,
            nonce_factory=lambda: "b" * 32,
        )

    async def asyncTearDown(self):
        await self.http.aclose()

    def assert_signed(self, request, body):
        timestamp = request.headers["X-KageCatch-Timestamp"]
        nonce = request.headers["X-KageCatch-Nonce"]
        body_hash = hashlib.sha256(body).hexdigest()
        canonical = f"{timestamp}\n{nonce}\n{request.method}\n{request.url.path}\n{body_hash}"
        expected = hmac.new(self.secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(request.headers["X-KageCatch-Signature"], expected)

    async def test_reserve_outbound_posts_signed_owner_chat_pacing_request(self):
        result = await self.client.reserve_outbound("7135051954", -100123456, minimum_interval_seconds=2)
        self.assertEqual(result, {"allowed": True, "nextAllowedAt": 200})
        request, body = self.requests[-1]
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.url.path, "/internal/telegram-safety/reserve")
        self.assertEqual(json.loads(body), {
            "ownerId": "7135051954",
            "chatId": "-100123456",
            "minimumIntervalSeconds": 2,
        })
        self.assert_signed(request, body)

    async def test_update_backoff_posts_signed_deadline(self):
        result = await self.client.update_backoff("7135051954", "flood_wait", 1_800_000_030)
        self.assertEqual(result, {"updated": True})
        request, body = self.requests[-1]
        self.assertEqual(request.url.path, "/internal/telegram-safety/backoff")
        self.assertEqual(json.loads(body), {
            "ownerId": "7135051954",
            "kind": "flood_wait",
            "until": 1_800_000_030,
        })
        self.assert_signed(request, body)

    async def test_set_owner_lock_posts_signed_lock_state(self):
        result = await self.client.set_owner_lock("7135051954", True, reason="manual_review")
        self.assertEqual(result, {"updated": True, "locked": True, "reason": "manual_review"})
        request, body = self.requests[-1]
        self.assertEqual(request.url.path, "/internal/telegram-safety/lock")
        self.assertEqual(json.loads(body), {
            "ownerId": "7135051954",
            "locked": True,
            "reason": "manual_review",
        })
        self.assert_signed(request, body)

    async def test_invalid_owner_chat_and_intervals_are_rejected_before_network(self):
        with self.assertRaises(ValueError):
            await self.client.reserve_outbound("../owner", 123)
        with self.assertRaises(ValueError):
            await self.client.reserve_outbound("7135051954", "not-a-chat")
        with self.assertRaises(ValueError):
            await self.client.reserve_outbound("7135051954", 123, minimum_interval_seconds=61)
        with self.assertRaises(ValueError):
            await self.client.update_backoff("7135051954", "unknown", 100)
        with self.assertRaises(ValueError):
            await self.client.set_owner_lock("7135051954", True, reason="x" * 161)
        self.assertEqual(self.requests, [])

    async def test_http_errors_are_not_converted_to_success(self):
        async def unavailable(request):
            return httpx.Response(503, json={"error": "safety_store_unavailable"})
        http = httpx.AsyncClient(transport=httpx.MockTransport(unavailable))
        client = D1TelegramSafetyClient("https://example.test", self.secret, client=http)
        try:
            with self.assertRaises(httpx.HTTPStatusError):
                await client.reserve_outbound("7135051954", 123)
        finally:
            await http.aclose()

    async def test_rejects_non_https_and_short_secret(self):
        with self.assertRaises(ValueError):
            D1TelegramSafetyClient("http://example.test", self.secret, client=self.http)
        with self.assertRaises(ValueError):
            D1TelegramSafetyClient("https://example.test", "short", client=self.http)


if __name__ == "__main__":
    unittest.main()
