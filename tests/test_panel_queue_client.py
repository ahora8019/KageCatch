import hashlib
import hmac
import json
import unittest

import httpx

from kagecatch.panel_queue_client import PanelQueueClient


class PanelQueueClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_posts_group_request_with_worker_hmac_contract(self):
        captured = {}

        async def handler(request):
            captured["request"] = request
            return httpx.Response(202, json={"accepted": True, "request_id": "req-123"})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        queue = PanelQueueClient(
            "https://worker.example",
            "s" * 40,
            client=client,
            clock=lambda: 1_800_000_000,
            nonce_factory=lambda: "a" * 32,
        )
        result = await queue.enqueue(
            owner_id="12345",
            chat_id=-100123456,
            source_message_id=987,
        )

        request = captured["request"]
        body = json.loads(request.content)
        self.assertEqual(request.url.path, "/internal/panel-requests")
        self.assertEqual(body, {
            "owner_id": "12345",
            "chat_id": -100123456,
            "source_message_id": 987,
        })
        body_hash = hashlib.sha256(request.content).hexdigest()
        signing_text = f"1800000000\n{'a' * 32}\nPOST\n/internal/panel-requests\n{body_hash}"
        expected = hmac.new(("s" * 40).encode(), signing_text.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(request.headers["X-KageCatch-Signature"], expected)
        self.assertTrue(result["accepted"])
        await queue.close()

    async def test_rejects_invalid_group_identity_before_network(self):
        queue = PanelQueueClient("https://worker.example", "s" * 40)
        with self.assertRaises(ValueError):
            await queue.enqueue(owner_id="not-numeric", chat_id=-100123, source_message_id=1)
        await queue.close()


if __name__ == "__main__":
    unittest.main()
