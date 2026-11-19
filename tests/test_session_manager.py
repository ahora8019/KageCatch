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

    async def put_pending(self, user_id, encrypted_payload):
        self.values[("pending", user_id)] = encrypted_payload

    async def get_pending(self, user_id):
        return self.values.get(("pending", user_id))

    async def delete_pending(self, user_id):
        self.values.pop(("pending", user_id), None)


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

    async def test_pending_authorization_payload_is_encrypted_and_round_trips(self):
        payload = {
            "version": 1,
            "phone": "+10000000000",
            "phone_code_hash": "private-phone-code-hash",
            "session_string": "temporary-telethon-session",
            "expires_at": 1_800_000_000,
            "attempts": 0,
        }
        await self.manager.save_pending_authorization("user-1", payload)
        encrypted = self.store.values[("pending", "user-1")]
        self.assertNotIn(b"private-phone-code-hash", encrypted)
        self.assertNotIn(b"temporary-telethon-session", encrypted)
        self.assertEqual(await self.manager.load_pending_authorization("user-1"), payload)
        await self.manager.delete_pending_authorization("user-1")
        self.assertIsNone(await self.manager.load_pending_authorization("user-1"))

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


    async def test_public_session_api_aliases_round_trip_and_revoke(self):
        await self.manager.save_session("user-1", "alias-session")
        self.assertEqual(await self.manager.get_session("user-1"), "alias-session")
        await self.manager.revoke_session("user-1")
        self.assertIsNone(await self.manager.get_session("user-1"))



    async def test_rejects_noncanonical_user_identifiers_before_storage_access(self):
        for invalid_user_id in (None, True, 123, "", " user-1", "user-1 ", "user\\n1", "用户-1"):
            with self.subTest(user_id=repr(invalid_user_id)):
                with self.assertRaises(ValueError):
                    await self.manager.load_session(invalid_user_id)
        self.assertEqual(self.store.values, {})

    async def test_pending_authorization_rejects_otp_and_password_fields(self):
        payload = {
            "version": 1,
            "phone": "+10000000000",
            "phone_code_hash": "opaque-hash",
            "session_string": "temporary-session",
            "expires_at": 1_800_000_000,
            "attempts": 0,
            "code": "12345",
            "password": "never-store-this",
        }
        with self.assertRaises(ValueError):
            await self.manager.save_pending_authorization("user-1", payload)
        self.assertNotIn(("pending", "user-1"), self.store.values)

    async def test_pending_authorization_validates_payload_schema_and_bounds(self):
        valid = {
            "version": 1,
            "phone": "+10000000000",
            "phone_code_hash": "opaque-hash",
            "session_string": "temporary-session",
            "expires_at": 1_800_000_000,
            "attempts": 0,
            "session_authorized": True,
        }
        await self.manager.save_pending_authorization("user-1", valid)
        self.assertEqual(await self.manager.load_pending_authorization("user-1"), valid)

        invalid_payloads = [
            {**valid, "version": True},
            {**valid, "phone": "not-a-phone"},
            {**valid, "phone_code_hash": ""},
            {**valid, "session_string": ""},
            {**valid, "expires_at": float("inf")},
            {**valid, "attempts": True},
            {**valid, "session_authorized": "yes"},
            {**valid, "unexpected": "field"},
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    await self.manager.save_pending_authorization("user-1", payload)

    async def test_authorized_session_input_must_be_a_bounded_string(self):
        for invalid_session in (None, 123, True, " "):
            with self.subTest(session=repr(invalid_session)):
                with self.assertRaises(ValueError):
                    await self.manager.save_authorized_session("user-1", invalid_session)
        with self.assertRaises(ValueError):
            await self.manager.save_authorized_session("user-1", "x" * 8193)
        self.assertEqual(self.store.values, {})


if __name__ == "__main__":
    unittest.main()
