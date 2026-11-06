import unittest
from unittest.mock import AsyncMock

from telethon.errors import SessionPasswordNeededError

from kagecatch.telegram_authorization import authorize_telethon_session


class FakeSession:
    def save(self):
        return "authorized-string-session"


class FakeClient:
    def __init__(self, password_required=False):
        self.session = FakeSession()
        self.password_required = password_required
        self.connected = True
        self.phone_hash = None
        self.signed_in = False

    async def send_code_request(self, phone):
        self.phone_hash = "opaque-code-hash"
        return type("SentCode", (), {"phone_code_hash": self.phone_hash})()

    async def sign_in(self, **kwargs):
        if "password" in kwargs:
            self.signed_in = True
            return
        if self.password_required:
            raise SessionPasswordNeededError(request=None)
        self.signed_in = True

    async def is_user_authorized(self):
        return self.signed_in

    async def disconnect(self):
        self.connected = False


class FakeManager:
    def __init__(self):
        self.saved = []

    async def save_authorized_session(self, user_id, session_string):
        self.saved.append((user_id, session_string))


class TelegramAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def test_authorizes_and_persists_only_after_telegram_confirms(self):
        client = FakeClient()
        manager = FakeManager()
        await authorize_telethon_session(
            client=client,
            user_id="user-1",
            phone="+10000000000",
            code_provider=AsyncMock(return_value="12345"),
            password_provider=AsyncMock(),
            session_manager=manager,
        )
        self.assertEqual(manager.saved, [("user-1", "authorized-string-session")])

    async def test_requests_two_factor_password_only_when_required(self):
        client = FakeClient(password_required=True)
        manager = FakeManager()
        password = AsyncMock(return_value="not-a-real-password")
        await authorize_telethon_session(
            client=client,
            user_id="user-1",
            phone="+10000000000",
            code_provider=AsyncMock(return_value="12345"),
            password_provider=password,
            session_manager=manager,
        )
        password.assert_awaited_once()
        self.assertEqual(len(manager.saved), 1)

    async def test_does_not_persist_when_telegram_does_not_authorize(self):
        client = FakeClient()
        client.is_user_authorized = AsyncMock(return_value=False)
        manager = FakeManager()
        with self.assertRaises(PermissionError):
            await authorize_telethon_session(
                client=client,
                user_id="user-1",
                phone="+10000000000",
                code_provider=AsyncMock(return_value="12345"),
                password_provider=AsyncMock(),
                session_manager=manager,
            )
        self.assertEqual(manager.saved, [])

    async def test_disconnects_client_if_authorization_fails(self):
        client = FakeClient(password_required=True)
        password = AsyncMock(side_effect=RuntimeError("provider failed"))
        with self.assertRaises(RuntimeError):
            await authorize_telethon_session(
                client=client,
                user_id="user-1",
                phone="+10000000000",
                code_provider=AsyncMock(return_value="12345"),
                password_provider=password,
                session_manager=FakeManager(),
            )
        self.assertFalse(client.connected)


if __name__ == "__main__":
    unittest.main()
