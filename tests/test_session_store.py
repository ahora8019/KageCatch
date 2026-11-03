import os
import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from kagecatch.runtime.session_store import EncryptedFileSessionStore, SessionStoreError


class EncryptedFileSessionStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name) / "sessions"
        self.key = Fernet.generate_key()
        self.store = EncryptedFileSessionStore(self.root, self.key)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_round_trips_a_session_without_writing_plaintext(self) -> None:
        session = "1AAAB3NzaC1yc2EAAAADAQABAAABAQ-private-telegram-session"

        self.store.save("account-123", session)
        stored_files = list(self.root.glob("*.session"))

        self.assertEqual(len(stored_files), 1)
        self.assertEqual(self.store.load("account-123"), session)
        self.assertNotIn(session.encode(), stored_files[0].read_bytes())
        self.assertNotIn("account-123", stored_files[0].name)

    def test_returns_none_for_an_account_without_a_saved_session(self) -> None:
        self.assertIsNone(self.store.load("not-enrolled"))

    def test_sessions_are_isolated_by_account(self) -> None:
        self.store.save("account-a", "session-a")
        self.store.save("account-b", "session-b")

        self.assertEqual(self.store.load("account-a"), "session-a")
        self.assertEqual(self.store.load("account-b"), "session-b")

    def test_rejects_empty_account_ids_and_empty_session_values(self) -> None:
        with self.assertRaises(ValueError):
            self.store.save(" ", "session")
        with self.assertRaises(ValueError):
            self.store.save("account-a", "")

    def test_rejects_invalid_encryption_keys(self) -> None:
        with self.assertRaises(ValueError):
            EncryptedFileSessionStore(self.root, b"not-a-fernet-key")

    def test_wrong_key_does_not_return_or_overwrite_plaintext(self) -> None:
        self.store.save("account-a", "private-session")
        other = EncryptedFileSessionStore(self.root, Fernet.generate_key())

        with self.assertRaises(SessionStoreError):
            other.load("account-a")

    def test_corrupted_ciphertext_is_reported_as_a_store_error(self) -> None:
        self.store.save("account-a", "private-session")
        session_file = next(self.root.glob("*.session"))
        session_file.write_bytes(b"corrupted")

        with self.assertRaises(SessionStoreError):
            self.store.load("account-a")

    @unittest.skipUnless(os.name == "posix", "POSIX permission semantics")
    def test_session_file_permissions_are_owner_only(self) -> None:
        self.store.save("account-a", "private-session")
        session_file = next(self.root.glob("*.session"))

        self.assertEqual(session_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main()
