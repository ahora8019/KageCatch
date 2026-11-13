import os
import tempfile
import unittest

from kagecatch.sqlite_session_store import SQLiteSessionStore


class SQLiteSessionStoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_encrypted_blob_survives_store_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "sessions.sqlite3")
            first = SQLiteSessionStore(path)
            await first.put("user-1", b"encrypted-blob")
            await first.close()

            second = SQLiteSessionStore(path)
            self.assertEqual(await second.get("user-1"), b"encrypted-blob")
            await second.close()

    async def test_pending_authorization_survives_store_reopen_and_is_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "sessions.sqlite3")
            first = SQLiteSessionStore(path)
            await first.put("user-1", b"authorized-session")
            await first.put_pending("user-1", b"encrypted-pending-challenge")
            await first.close()

            second = SQLiteSessionStore(path)
            self.assertEqual(await second.get("user-1"), b"authorized-session")
            self.assertEqual(await second.get_pending("user-1"), b"encrypted-pending-challenge")
            await second.delete_pending("user-1")
            self.assertIsNone(await second.get_pending("user-1"))
            self.assertEqual(await second.get("user-1"), b"authorized-session")
            await second.close()

    async def test_put_replaces_existing_session(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SQLiteSessionStore(os.path.join(directory, "sessions.sqlite3"))
            await store.put("user-1", b"old")
            await store.put("user-1", b"new")
            self.assertEqual(await store.get("user-1"), b"new")
            await store.close()

    async def test_delete_removes_session(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SQLiteSessionStore(os.path.join(directory, "sessions.sqlite3"))
            await store.put("user-1", b"encrypted")
            await store.delete("user-1")
            self.assertIsNone(await store.get("user-1"))
            await store.close()


if __name__ == "__main__":
    unittest.main()
