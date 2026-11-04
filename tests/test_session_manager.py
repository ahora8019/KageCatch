import unittest

from cryptography.fernet import Fernet

from kagecatch.session_manager import SessionManager


class MemoryStore:
    def __init__(self):
        self.values = {}

    async def put(self, user_id, encrypted_session):
        self.values[user_id] = encrypted_session

    async def get(self, user_id):
        return self.values.get(user_id)

    async def delete(self, user_id):
        self.values.pop(user_id, None)


class SessionManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.key = Fernet.generate_key()
        self.store = MemoryStore()
        self.manager = SessionManager(fernet_key=self.key, store=self.store)

    async def test_session_is_encrypted_at_rest_and_round_trips(self):
        raw = "telethon-session-secret"
        await self.manager.save_authorized_session("user-1", raw)
        self.assertNotIn(raw.encode(), self.store.values["user-1"])
        self.assertEqual(await self.manager.load_session("user-1"), raw)

    async def test_revocation_deletes_encrypted_session(self):
        await self.manager.save_authorized_session("user-1", "session")
        await self.manager.revoke_session("user-1")
        self.assertIsNone(await self.manager.load_session("user-1"))

    async def test_wrong_key_fails_closed(self):
        await self.manager.save_authorized_session("user-1", "session")
        other = SessionManager(fernet_key=Fernet.generate_key(), store=self.store)
        with self.assertRaises(ValueError):
            await other.load_session("user-1")

    async def test_empty_session_is_rejected(self):
        with self.assertRaises(ValueError):
            await self.manager.save_authorized_session("user-1", " ")

    async def test_invalid_user_is_rejected(self):
        with self.assertRaises(ValueError):
            await self.manager.load_session("")


if __name__ == "__main__":
    unittest.main()
