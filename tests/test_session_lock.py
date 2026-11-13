import unittest
from unittest.mock import AsyncMock
import httpx
from kagecatch.session_lock import D1SessionLease, SessionLockUnavailable


class SessionLockTests(unittest.IsolatedAsyncioTestCase):
    async def test_acquire_false_does_not_mark_held(self):
        async def handler(request):
            return httpx.Response(200, json={"acquired": False})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        lease = D1SessionLease("https://worker.example", "x" * 40, client=client)
        self.assertFalse(await lease.acquire("123"))
        self.assertFalse(lease.held)
        await client.aclose()

    async def test_acquire_starts_owned_lease_and_release(self):
        calls = []
        async def handler(request):
            calls.append(request.url.path)
            if request.url.path.endswith("/acquire"):
                return httpx.Response(200, json={"acquired": True, "expires_at": 2000})
            return httpx.Response(200, json={"released": True})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        lease = D1SessionLease("https://worker.example", "x" * 40, client=client)
        self.assertTrue(await lease.acquire("123"))
        self.assertTrue(lease.held)
        await lease.release()
        self.assertFalse(lease.held)
        self.assertIn("/internal/session-locks/release", calls)
        await client.aclose()

    async def test_heartbeat_failure_marks_lease_lost(self):
        calls = 0
        async def handler(request):
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(200, json={"acquired": True, "expires_at": 2000})
            return httpx.Response(409, json={"renewed": False})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        lease = D1SessionLease("https://worker.example", "x" * 40,
                               lease_seconds=30, heartbeat_seconds=1, client=client)
        self.assertTrue(await lease.acquire("123"))
        await __import__("asyncio").sleep(1.1)
        self.assertFalse(lease.held)
        await lease.release()
        await client.aclose()

    async def test_requires_https_and_strong_secret(self):
        with self.assertRaises(ValueError):
            D1SessionLease("http://worker.example", "x" * 40)
        with self.assertRaises(ValueError):
            D1SessionLease("https://worker.example", "short")
