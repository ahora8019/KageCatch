import hashlib
import hmac
import json
import time
import unittest

from fastapi.testclient import TestClient

from kagecatch.core_api import InMemoryNonceStore, create_app


class FakePhoneFlow:
    def __init__(self):
        self.calls = []
    async def start(self, *, user_id, phone):
        self.calls.append(("start", user_id, phone))
        return "code_sent"
    async def submit_code(self, *, user_id, code):
        self.calls.append(("code", user_id, code))
        return "password_required" if code == "needs-2fa" else "connected"
    async def submit_password(self, *, user_id, password):
        self.calls.append(("password", user_id, password))
        return "connected"
    async def get_status(self, *, user_id):
        return {"status": "pending"}
    async def cancel(self, *, user_id):
        self.calls.append(("cancel", user_id))


class FakeRuntime:
    def __init__(self):
        self.connected = []
    async def connect_user(self, user_id):
        self.connected.append(user_id)


class FakeSessions:
    async def load_session(self, user_id):
        return None


class PhoneAuthApiTests(unittest.TestCase):
    def setUp(self):
        self.secret = "unit-test-key-with-at-least-thirty-two-bytes"
        self.flow = FakePhoneFlow()
        self.runtime = FakeRuntime()
        self.client = TestClient(create_app(core_secret=self.secret, runtime=self.runtime, session_manager=FakeSessions(), auth_flow=self.flow, nonce_store=InMemoryNonceStore()))
    def post(self, path, payload, nonce):
        body = json.dumps(payload, separators=(",", ":")).encode()
        timestamp = str(int(time.time()))
        digest = hashlib.sha256(body).hexdigest()
        message = f"{timestamp}\\n{nonce}\\nPOST\\n{path}\\n{digest}".encode()
        signature = hmac.new(self.secret.encode(), message, hashlib.sha256).hexdigest()
        headers = {"X-KageCatch-Timestamp": timestamp, "X-KageCatch-Nonce": nonce, "X-KageCatch-Signature": signature, "content-type": "application/json"}
        return self.client.post(path, content=body, headers=headers)
    def test_connect_starts_phone_login(self):
        path = "/v1/accounts/2001/connect"
        response = self.post(path, {"phone": "+10000000000"}, "phone-start-test-0001")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "code_sent"})
        self.assertEqual(self.flow.calls, [("start", "2001", "+10000000000")])
    def test_code_challenge_can_require_two_factor_without_connecting(self):
        path = "/v1/accounts/2001/connect/code"
        response = self.post(path, {"code": "needs-2fa"}, "phone-code-test-0001")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "password_required"})
        self.assertEqual(self.runtime.connected, [])
    def test_successful_code_connects_only_after_authorization(self):
        path = "/v1/accounts/2001/connect/code"
        response = self.post(path, {"code": "valid-test-code"}, "phone-code-test-0002")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "connected"})
        self.assertEqual(self.runtime.connected, ["2001"])
    def test_two_factor_success_connects_runtime(self):
        path = "/v1/accounts/2001/connect/password"
        response = self.post(path, {"password": "test-only-value"}, "phone-pass-test-001")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "connected"})
        self.assertEqual(self.runtime.connected, ["2001"])


if __name__ == "__main__":
    unittest.main()
