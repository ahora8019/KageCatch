import asyncio
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
        self.connect_calls = []
        self.session_manager = None

    @property
    def active_user_count(self):
        return len(self.clients)

    async def get_client(self, user_id):
        return self.clients.get(user_id)

    async def connect_user(self, user_id):
        self.connect_calls.append(user_id)
        self.clients[user_id] = object()
        return self.clients[user_id]

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


class FakeAuthFlow:
    def __init__(self):
        self.cancelled = []
        self.status = "pending"

    async def start(self, *, user_id, phone):
        return "code_sent"

    async def get_status(self, *, user_id):
        return {"status": self.status, "expires_in": 20, "login_url": "tg://login?token=one-time"}

    async def cancel(self, *, user_id):
        self.cancelled.append(user_id)


class CoreApiTests(unittest.TestCase):
    def setUp(self):
        self.runtime = FakeRuntime()
        self.sessions = FakeSessionManager()
        self.runtime.session_manager = self.sessions
        self.auth_flow = FakeAuthFlow()
        self.app = create_app(
            core_secret=SECRET,
            runtime=self.runtime,
            session_manager=self.sessions,
            auth_flow=self.auth_flow,
            nonce_store=InMemoryNonceStore(),
        )
        self.client = TestClient(self.app)

    def test_app_startup_restores_saved_sessions(self):
        class StartupRuntime(FakeRuntime):
            def __init__(self):
                super().__init__()
                self.restore_called = False

            async def restore_saved_sessions(self):
                self.restore_called = True
                return {"connected": 2, "failed": 0}

        runtime = StartupRuntime()
        app = create_app(
            core_secret=SECRET,
            runtime=runtime,
            session_manager=self.sessions,
            auth_flow=self.auth_flow,
            nonce_store=InMemoryNonceStore(),
        )
        with TestClient(app):
            self.assertTrue(runtime.restore_called)

    def test_review_pipeline_is_wired_to_the_runtime_selfbot_incoming_listener(self):
        class SelfbotRegistry:
            def __init__(self):
                self.handler = None

            def set_incoming_handler(self, handler):
                self.handler = handler

        class RuntimeWithSelfbot(FakeRuntime):
            def __init__(self):
                super().__init__()
                self._selfbot_controller = SelfbotRegistry()

        class Pipeline:
            def __init__(self):
                self.events = []

            async def process(self, *, event, user_id):
                self.events.append((user_id, event))
                return {"status": "no_spawn"}

        runtime = RuntimeWithSelfbot()
        pipeline = Pipeline()
        app = create_app(
            core_secret=SECRET, runtime=runtime, session_manager=self.sessions,
            auth_flow=self.auth_flow, review_pipeline=pipeline,
        )
        event = object()
        with TestClient(app):
            self.assertIsNotNone(runtime._selfbot_controller.handler)
            asyncio.run(runtime._selfbot_controller.handler("2001", event))

        self.assertEqual(pipeline.events, [("2001", event)])

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


    def test_account_info_returns_masked_phone_and_authorization_health_without_session_material(self):
        from datetime import datetime, timezone
        from types import SimpleNamespace

        class AccountClient:
            async def is_user_authorized(self):
                return True

            async def get_me(self):
                return SimpleNamespace(
                    phone="+989121234567",
                    status=SimpleNamespace(was_online=datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)),
                )

        self.runtime.clients["2001"] = AccountClient()
        path = "/v1/accounts/2001/info"
        response = self.client.get(path, headers=signed_headers("GET", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "telegram_user_id": 2001,
            "session_health": "valid",
            "phone_masked": "+9891******67",
            "last_active": "2026-11-13T12:00:00+00:00",
        })
        self.assertNotIn("+989121234567", response.text)
        self.assertNotIn("do-not-return-this-session", response.text)


    def test_account_status_does_not_reconnect_a_saved_session_automatically(self):
        self.runtime.clients.clear()
        path = "/v1/accounts/2001"
        response = self.client.get(path, headers=signed_headers("GET", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "authorized")
        self.assertEqual(self.runtime.connect_calls, [])

    def test_explicit_reconnect_activates_a_saved_session(self):
        self.runtime.clients.clear()
        path = "/v1/accounts/2001/reconnect"
        response = self.client.post(path, headers=signed_headers("POST", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "connected")
        self.assertEqual(self.runtime.connect_calls, ["2001"])

    def test_disconnect_preserves_authorized_session(self):
        path = "/v1/accounts/2001/disconnect"
        response = self.client.post(path, headers=signed_headers("POST", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "disconnected")
        self.assertIn("2001", self.sessions.sessions)
        self.assertEqual(self.runtime.disconnected, ["2001"])
        status_path = "/v1/accounts/2001"
        status_response = self.client.get(status_path, headers=signed_headers("GET", status_path, nonce="status-after-disconnect-0001"))
        self.assertEqual(status_response.json()["status"], "authorized")
        self.assertEqual(self.runtime.connect_calls, [])


    def test_connect_starts_phone_login_without_returning_credentials(self):
        path = "/v1/accounts/2001/connect"
        body = json.dumps({"phone": "+10000000000"}).encode()
        response = self.client.post(path, content=body, headers=signed_headers("POST", path, body))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "code_sent"})

    def test_connect_status_is_available_to_worker(self):
        path = "/v1/accounts/2001/connect/status"
        response = self.client.get(path, headers=signed_headers("GET", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "pending")


    def test_successful_telegram_confirmation_starts_the_execution_client(self):
        self.auth_flow.status = "connected"
        path = "/v1/accounts/2001/connect/status"
        response = self.client.get(path, headers=signed_headers("GET", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "connected")
        self.assertEqual(self.runtime.connect_calls, ["2001"])

    def test_connect_can_be_cancelled(self):
        path = "/v1/accounts/2001/connect/cancel"
        response = self.client.post(path, headers=signed_headers("POST", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "cancelled")
        self.assertEqual(self.auth_flow.cancelled, ["2001"])

    def test_revoke_disconnects_and_deletes_authorized_session(self):
        path = "/v1/accounts/2001"
        response = self.client.delete(path, headers=signed_headers("DELETE", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "revoked")
        self.assertNotIn("2001", self.sessions.sessions)
        self.assertEqual(self.runtime.revoked, ["2001"])


    def test_catch_status_reports_controller_state_for_connected_owner(self):
        class Selfbot:
            def __init__(self):
                self.enabled = set()
            def is_enabled(self, user_id):
                return user_id in self.enabled
            def set_enabled(self, user_id, enabled):
                if enabled: self.enabled.add(user_id)
                else: self.enabled.discard(user_id)
                return enabled
        self.runtime._selfbot_controller = Selfbot()
        path = "/v1/accounts/2001/catch"
        response = self.client.get(path, headers=signed_headers("GET", path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"telegram_user_id": 2001, "enabled": False, "execution_ready": False})

    def test_owner_can_toggle_catch_mode_without_claiming_execution_is_ready(self):
        class Selfbot:
            def __init__(self):
                self.enabled = set()
            def is_enabled(self, user_id):
                return user_id in self.enabled
            def set_enabled(self, user_id, enabled):
                if enabled: self.enabled.add(user_id)
                else: self.enabled.discard(user_id)
                return enabled
        self.runtime._selfbot_controller = Selfbot()
        path = "/v1/accounts/2001/catch"
        body = json.dumps({"enabled": True}).encode()
        response = self.client.put(path, content=body, headers=signed_headers("PUT", path, body))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"telegram_user_id": 2001, "enabled": True, "execution_ready": False})
        self.assertIn("2001", self.runtime._selfbot_controller.enabled)

    def test_catch_toggle_requires_a_connected_account_and_valid_boolean(self):
        self.runtime.clients.clear()
        path = "/v1/accounts/2001/catch"
        body = json.dumps({"enabled": True}).encode()
        response = self.client.put(path, content=body, headers=signed_headers("PUT", path, body))
        self.assertEqual(response.status_code, 409)
