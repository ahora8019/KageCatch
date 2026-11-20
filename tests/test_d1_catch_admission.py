import hashlib
import hmac
import json
import unittest

import httpx

from kagecatch.d1_catch_admission import D1CatchAdmissionStore

SECRET = "catch-admission-secret-with-at-least-32-bytes"
BASE_URL = "https://control.example.test"


class D1CatchAdmissionStoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_reserve_uses_signed_worker_endpoint_and_returns_decision(self):
        observed = {}

        async def handler(request):
            observed["request"] = request
            return httpx.Response(201, json={"status": "admitted"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            store = D1CatchAdmissionStore(BASE_URL, SECRET, max_attempts=3, window_seconds=90,
                                          client=client, clock=lambda: 1794140000,
                                          nonce_factory=lambda: "b" * 32)
            result = await store.reserve(user_id="user-1", source="senpai_catcher", dedupe_key="spawn:44")

        request = observed["request"]
        payload = json.loads(request.content)
        self.assertEqual(result, "admitted")
        self.assertEqual(request.url.path, "/internal/job-queue")
        self.assertEqual(payload["action"], "admit_catch")
        self.assertEqual(payload["max_attempts"], 3)
        signing_text = "\n".join([request.headers["X-KageCatch-Timestamp"],
            request.headers["X-KageCatch-Nonce"], "POST", "/internal/job-queue",
            hashlib.sha256(request.content).hexdigest()])
        expected = hmac.new(SECRET.encode(), signing_text.encode(), hashlib.sha256).hexdigest()
        self.assertTrue(hmac.compare_digest(expected, request.headers["X-KageCatch-Signature"]))

    async def test_rejects_invalid_identity_and_configuration(self):
        with self.assertRaises(ValueError):
            D1CatchAdmissionStore("http://control.example.test", SECRET)
        with self.assertRaises(ValueError):
            D1CatchAdmissionStore(BASE_URL, "short")
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"status":"admitted"}))) as client:
            store = D1CatchAdmissionStore(BASE_URL, SECRET, client=client)
            with self.assertRaises(ValueError):
                await store.reserve(user_id="user-1", source="../bad", dedupe_key="spawn")
            with self.assertRaises(ValueError):
                await store.reserve(user_id="user-1", source="senpai_catcher", dedupe_key="")

    async def test_fails_closed_on_unknown_worker_decision(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"status":"maybe"}))) as client:
            store = D1CatchAdmissionStore(BASE_URL, SECRET, client=client)
            with self.assertRaises(RuntimeError):
                await store.reserve(user_id="user-1", source="senpai_catcher", dedupe_key="spawn")


if __name__ == "__main__":
    unittest.main()
