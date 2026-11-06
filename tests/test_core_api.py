import hashlib
import hmac
import json
import time
import unittest

from fastapi.testclient import TestClient

from kagecatch.core_api import InMemoryNonceStore, create_app


SECRET = "core-test-secret-0123456789abcdef"


def signed_headers(method, path, body=b"", *, timestamp=None, nonce="test-nonce-00000001", secret=SECRET):
    timestamp = int(time.time()) if timestamp is None else timestamp
    body_hash = hashlib.sha256(body).hexdigest()
    message = f"{timestamp}\n{nonce}\n{method.upper()}\n{path}\n{body_hash}".encode()
    signature = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    return {
        "X-KageCatch-Timestamp": str(timestamp),
        "X-KageCatch-Nonce": nonce,
        "X-KageCatch-Signature": signature,
    }


class FakeRuntime:
    def __init__(self):
        self.clients = {"2001": object()}
        self.disconnected = []
        self.revoked = []
        self.session_manager = None

    @property
    def active_user_count(self):
        return len(self.clients)

    async def get_client(self, user_id):
        return self.clients.get(user_id)

    async def disconnect_user(self, user_id):
        self.disconnected.append(user_id)
        self.clients.pop(user_id, None)

    async def revoke_user(self, user_id):
        self.revoked.append(user_id)
        self.clients.pop(user_id, None)
        await self.session_manager.revoke_session(user_id)


class FakeSessionManager:
    def __init__(self):
        self.sessions = {"2001": "do-not-return-this-session"}
        self.revoked = []

    async def load_session(self, user_id):
        return self.sessions.get(user_id)

    async def revoke_session(self, user_id):
        self.revoked.append(user_id)
        self.sessions.pop(user_id, None)


class CoreApiTests(unittest.TestCase):
    def setUp(self):
        self.runtime = FakeRuntime()
        self.sessions = FakeSessionManager()
        self.runtime.session_manager = self.sessions
        self.app = create_app(
            core_secret=SECRET,
            runtime=self.runtime,
            session_manager=self.sessions,
            nonce_store=InMemoryNonceStore(),
        )
        self.client = TestClient(self.app)

    def test_public_liveness_endpoint_discloses_no_private_state(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"service": "KageCatch Core", "status": "alive"})

    def test_signed_health_endpoint_reports_runtime_readiness(self):
        path = "/v1/health"
        response = self.client.get(path, headers=signed_headers("GET", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(response.json()["active_clients"], 1)

    def test_invalid_signature_is_rejected(self):
        path = "/v1/health"
        headers = signed_headers("GET", path)
        headers["X-KageCatch-Signature"] = "0" * 64
        response = self.client.get(path, headers=headers)
        self.assertEqual(response.status_code, 401)

    def test_stale_request_timestamp_is_rejected(self):
        path = "/v1/health"
        headers = signed_headers("GET", path, timestamp=int(time.time()) - 300)
        response = self.client.get(path, headers=headers)
        self.assertEqual(response.status_code, 401)

    def test_replayed_nonce_is_rejected(self):
        path = "/v1/health"
        headers = signed_headers("GET", path, nonce="replay-me-00000001")
        self.assertEqual(self.client.get(path, headers=headers).status_code, 200)
        self.assertEqual(self.client.get(path, headers=headers).status_code, 409)

    def test_account_status_never_returns_session_material(self):
        path = "/v1/accounts/2001"
        response = self.client.get(path, headers=signed_headers("GET", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "telegram_user_id": 2001,
            "status": "connected",
            "session_saved": True,
            "connected": True,
        })
        self.assertNotIn("do-not-return-this-session", response.text)

    def test_disconnect_preserves_authorized_session(self):
        path = "/v1/accounts/2001/disconnect"
        response = self.client.post(path, headers=signed_headers("POST", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "disconnected")
        self.assertIn("2001", self.sessions.sessions)
        self.assertEqual(self.runtime.disconnected, ["2001"])

    def test_revoke_disconnects_and_deletes_authorized_session(self):
        path = "/v1/accounts/2001"
        response = self.client.delete(path, headers=signed_headers("DELETE", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "revoked")
        self.assertNotIn("2001", self.sessions.sessions)
        self.assertEqual(self.runtime.revoked, ["2001"])
