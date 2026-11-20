import hashlib
import hmac
import json
import unittest

import httpx

from kagecatch.d1_job_queue import D1JobQueue

SECRET = "test-secret-with-at-least-thirty-two-bytes"
BASE_URL = "https://control.example.test"


class D1JobQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_enqueue_uses_signed_internal_endpoint_and_returns_job(self):
        observed = {}

        async def handler(request):
            observed["request"] = request
            return httpx.Response(201, json={"job": {
                "job_id": "a" * 32, "job_type": "recognize", "payload": {"spawn_id": 4},
                "priority": 2, "status": "queued", "attempts": 0, "max_attempts": 3,
                "worker_id": None, "lease_until": None, "lease_generation": 0,
            }})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            queue = D1JobQueue(BASE_URL, SECRET, client=client,
                               clock=lambda: 1794140000, nonce_factory=lambda: "b" * 32)
            job = await queue.enqueue("recognize", {"spawn_id": 4}, priority=2,
                                      idempotency_key="spawn:4")

        request = observed["request"]
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.url.path, "/internal/job-queue")
        payload = json.loads(request.content)
        self.assertEqual(payload["action"], "enqueue")
        self.assertEqual(payload["idempotency_key"], "spawn:4")
        signing_text = "\n".join([
            request.headers["X-KageCatch-Timestamp"],
            request.headers["X-KageCatch-Nonce"], "POST", "/internal/job-queue",
            hashlib.sha256(request.content).hexdigest(),
        ])
        expected = hmac.new(SECRET.encode(), signing_text.encode(), hashlib.sha256).hexdigest()
        self.assertTrue(hmac.compare_digest(expected, request.headers["X-KageCatch-Signature"]))
        self.assertEqual(job.job_id, "a" * 32)
        self.assertEqual(job.payload, {"spawn_id": 4})

    async def test_claim_and_complete_are_fenced_by_worker_and_generation(self):
        calls = []

        async def handler(request):
            payload = json.loads(request.content)
            calls.append(payload)
            if payload["action"] == "claim":
                return httpx.Response(200, json={"job": {
                    "job_id": "c" * 32, "job_type": "recognize", "payload": {},
                    "priority": 0, "status": "running", "attempts": 1, "max_attempts": 3,
                    "worker_id": "worker-a", "lease_until": 1794140060, "lease_generation": 7,
                }})
            return httpx.Response(200, json={"status": "completed"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            queue = D1JobQueue(BASE_URL, SECRET, client=client)
            job = await queue.claim_next("worker-a", lease_seconds=60, job_types=["recognize"])
            await queue.complete(job.job_id, "worker-a", lease_generation=job.lease_generation)

        self.assertEqual(calls[0]["action"], "claim")
        self.assertEqual(calls[1], {
            "action": "complete", "job_id": "c" * 32,
            "worker_id": "worker-a", "lease_generation": 7,
        })

    async def test_rejects_invalid_fenced_transition_before_network_call(self):
        calls = 0

        async def handler(request):
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"status": "completed"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            queue = D1JobQueue(BASE_URL, SECRET, client=client)
            with self.assertRaises(ValueError):
                await queue.complete("", "worker-a", lease_generation=1)
            with self.assertRaises(ValueError):
                await queue.complete("job-a", "worker-a", lease_generation=-1)
            with self.assertRaises(ValueError):
                await queue.complete("job-a", "worker-a", lease_generation=True)

        self.assertEqual(calls, 0)

    async def test_rejects_insecure_url_and_short_secret(self):
        with self.assertRaises(ValueError):
            D1JobQueue("http://control.example.test", SECRET)
        with self.assertRaises(ValueError):
            D1JobQueue(BASE_URL, "short")


if __name__ == "__main__":
    unittest.main()
