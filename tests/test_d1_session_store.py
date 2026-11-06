import base64
import hashlib
import hmac
import json
import unittest
from urllib.parse import quote

import httpx
from cryptography.fernet import Fernet

from kagecatch.d1_session_store import D1SessionStore
from kagecatch.session_manager import SessionManager


class D1SessionStoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.secret = "test-session-store-secret-that-is-at-least-32-bytes"
        self.ciphertext = b"encrypted-fern-et-session"

        async def handler(request):
            body = await request.aread()
            self.requests.append((request, body))
            if request.method == "GET":
                return httpx.Response(200, json={"ciphertext": base64.b64encode(self.ciphertext).decode()})
            if request.method == "PUT":
                return httpx.Response(200, json={"status": "stored"})
            if request.method == "DELETE":
                return httpx.Response(200, json={"status": "deleted"})
            return httpx.Response(405)

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.store = D1SessionStore(
            base_url="https://kagecatch-control.ahora-project.workers.dev",
            secret=self.secret,
            client=self.client,
            clock=lambda: 1_800_000_000,
            nonce_factory=lambda: "a" * 32,
        )

    async def asyncTearDown(self):
        await self.client.aclose()

    def assert_signed(self, request, body):
        timestamp = request.headers["X-KageCatch-Timestamp"]
        nonce = request.headers["X-KageCatch-Nonce"]
        body_hash = hashlib.sha256(body).hexdigest()
        signing_text = f"{timestamp}\n{nonce}\n{request.method}\n{request.url.path}\n{body_hash}"
        expected = hmac.new(self.secret.encode(), signing_text.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(request.headers["X-KageCatch-Signature"], expected)

    async def test_put_sends_only_encrypted_bytes_and_valid_hmac(self):
        await self.store.put("7135051954", self.ciphertext)
        request, body = self.requests[-1]
        self.assertEqual(request.method, "PUT")
        self.assertEqual(request.url.path, "/internal/session-store/7135051954")
        self.assertEqual(json.loads(body), {"ciphertext": base64.b64encode(self.ciphertext).decode()})
        self.assert_signed(request, body)

    async def test_get_returns_original_ciphertext(self):
        result = await self.store.get("7135051954")
        self.assertEqual(result, self.ciphertext)
        request, body = self.requests[-1]
        self.assertEqual(request.method, "GET")
        self.assertEqual(body, b"")
        self.assert_signed(request, body)

    async def test_get_missing_session_returns_none(self):
        async def missing(request):
            return httpx.Response(404, json={"error": "session_not_found"})
        client = httpx.AsyncClient(transport=httpx.MockTransport(missing))
        store = D1SessionStore("https://example.workers.dev", self.secret, client=client)
        try:
            self.assertIsNone(await store.get("7135051954"))
        finally:
            await client.aclose()

    async def test_delete_uses_signed_request(self):
        await self.store.delete("7135051954")
        request, body = self.requests[-1]
        self.assertEqual(request.method, "DELETE")
        self.assert_signed(request, body)

    async def test_rejects_invalid_user_id_before_network_request(self):
        with self.assertRaises(ValueError):
            await self.store.get("../other-user")
        self.assertEqual(self.requests, [])

    async def test_rejects_invalid_ciphertext_response(self):
        async def malformed(request):
            return httpx.Response(200, json={"ciphertext": "not-base64!"})
        client = httpx.AsyncClient(transport=httpx.MockTransport(malformed))
        store = D1SessionStore("https://example.workers.dev", self.secret, client=client)
        try:
            with self.assertRaises(RuntimeError):
                await store.get("7135051954")
        finally:
            await client.aclose()

    async def test_pending_auth_challenge_uses_separate_signed_endpoint(self):
        await self.store.put_pending("7135051954", self.ciphertext)
        request, body = self.requests[-1]
        self.assertEqual(request.method, "PUT")
        self.assertEqual(request.url.path, "/internal/auth-challenge/7135051954")
        self.assertEqual(json.loads(body), {"ciphertext": base64.b64encode(self.ciphertext).decode()})
        self.assert_signed(request, body)

    async def test_pending_auth_challenge_round_trip_and_delete(self):
        stored = {}
        async def handler(request):
            body = await request.aread()
            self.requests.append((request, body))
            if request.method == "PUT":
                stored["ciphertext"] = json.loads(body)["ciphertext"]
                return httpx.Response(200, json={"status": "stored"})
            if request.method == "GET" and stored:
                return httpx.Response(200, json={"ciphertext": stored["ciphertext"]})
            if request.method == "DELETE":
                stored.clear()
                return httpx.Response(200, json={"status": "deleted"})
            return httpx.Response(404, json={"error": "challenge_not_found"})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        store = D1SessionStore("https://example.workers.dev", self.secret, client=client)
        try:
            await store.put_pending("7135051954", self.ciphertext)
            self.assertEqual(await store.get_pending("7135051954"), self.ciphertext)
            await store.delete_pending("7135051954")
            self.assertIsNone(await store.get_pending("7135051954"))
            self.assertTrue(all("/internal/auth-challenge/" in req.url.path for req, _ in self.requests[-4:]))
        finally:
            await client.aclose()

    async def test_rejects_short_secret(self):
        with self.assertRaises(ValueError):
            D1SessionStore("https://example.workers.dev", "short", client=self.client)

    async def test_session_manager_encrypts_before_d1_transport_and_decrypts_after_read(self):
        stored = {}
        observed_bodies = []

        async def handler(request):
            body = await request.aread()
            if request.method == "PUT":
                payload = json.loads(body)
                observed_bodies.append(body)
                stored["ciphertext"] = payload["ciphertext"]
                return httpx.Response(200, json={"status": "stored"})
            if request.method == "GET" and "ciphertext" in stored:
                return httpx.Response(200, json={"ciphertext": stored["ciphertext"]})
            if request.method == "DELETE":
                stored.clear()
                return httpx.Response(200, json={"status": "deleted"})
            return httpx.Response(404, json={"error": "session_not_found"})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        store = D1SessionStore("https://example.workers.dev", self.secret, client=client)
        manager = SessionManager(fernet_key=Fernet.generate_key(), store=store)
        raw_session = "1AgAOMTQwLjQwLjAuMQB7SENSITIVE-TELEGRAM-SESSION"
        try:
            await manager.save_authorized_session("7135051954", raw_session)
            self.assertNotIn(raw_session.encode(), observed_bodies[0])
            self.assertNotEqual(stored["ciphertext"], base64.b64encode(raw_session.encode()).decode())
            self.assertEqual(await manager.load_session("7135051954"), raw_session)
            await manager.revoke_session("7135051954")
            self.assertEqual(stored, {})
        finally:
            await client.aclose()


if __name__ == "__main__":
    unittest.main()
