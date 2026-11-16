import importlib.util
import os
import unittest
from unittest.mock import patch

from kagecatch.core_api import _configuration_presence, _resolve_session_store_mode


class RuntimeConfigurationTests(unittest.TestCase):
    def test_configuration_report_exposes_presence_only_never_secret_values(self):
        values = {
            "KAGECATCH_CORE_SECRET": "private-core-secret-value",
            "KAGECATCH_API_ID": "123456",
            "KAGECATCH_API_HASH": "private-api-hash",
            "KAGECATCH_FERNET_KEY": "private-fernet-key",
        }
        with patch.dict(os.environ, values, clear=True):
            report = _configuration_presence()

        self.assertEqual(report, {
            "core_auth_configured": True,
            "telegram_api_id_configured": True,
            "telegram_api_hash_configured": True,
            "session_encryption_key_configured": True,
            "session_store_url_configured": False,
            "distributed_session_lock_configured": False,
            "telethon_available": importlib.util.find_spec("telethon") is not None,
        })
        self.assertNotIn("private-core-secret-value", repr(report))
        self.assertNotIn("private-api-hash", repr(report))
        self.assertNotIn("private-fernet-key", repr(report))

    def test_configuration_report_marks_missing_values_without_returning_them(self):
        with patch.dict(os.environ, {}, clear=True):
            report = _configuration_presence()

        self.assertEqual(report, {
            "core_auth_configured": False,
            "telegram_api_id_configured": False,
            "telegram_api_hash_configured": False,
            "session_encryption_key_configured": False,
            "session_store_url_configured": False,
            "distributed_session_lock_configured": False,
            "telethon_available": importlib.util.find_spec("telethon") is not None,
        })

    def test_configuration_report_marks_distributed_lock_only_when_url_and_secret_exist(self):
        values = {
            "KAGECATCH_SESSION_STORE_URL": "https://private-worker.example",
            "KAGECATCH_CORE_SECRET": "x" * 40,
        }
        with patch.dict(os.environ, values, clear=True):
            report = _configuration_presence()
        self.assertTrue(report["distributed_session_lock_configured"])
        self.assertNotIn("private-worker.example", repr(report))
        self.assertNotIn("x" * 40, repr(report))

    def test_configuration_report_marks_d1_session_store_url_without_exposing_it(self):
        with patch.dict(os.environ, {"KAGECATCH_SESSION_STORE_URL": "https://private-worker.example"}, clear=True):
            report = _configuration_presence()

        self.assertTrue(report["session_store_url_configured"])
        self.assertFalse(report["distributed_session_lock_configured"])
        self.assertNotIn("private-worker.example", repr(report))

    def test_local_development_keeps_sqlite_when_distributed_lock_is_not_required(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(_resolve_session_store_mode(), "sqlite")

    def test_render_environment_fails_closed_when_d1_url_is_missing(self):
        with patch.dict(os.environ, {"RENDER": "true"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "distributed session lock requires"):
                _resolve_session_store_mode()

    def test_explicit_distributed_mode_fails_closed_when_d1_url_is_missing(self):
        with patch.dict(os.environ, {"KAGECATCH_REQUIRE_DISTRIBUTED_SESSION_LOCK": "true"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "distributed session lock requires"):
                _resolve_session_store_mode()

    def test_d1_url_without_valid_core_secret_fails_closed(self):
        values = {
            "KAGECATCH_SESSION_STORE_URL": "https://private-worker.example",
            "KAGECATCH_CORE_SECRET": "too-short",
        }
        with patch.dict(os.environ, values, clear=True):
            with self.assertRaisesRegex(RuntimeError, "at least 32 bytes"):
                _resolve_session_store_mode()

    def test_distributed_mode_requires_both_d1_url_and_strong_secret(self):
        values = {
            "KAGECATCH_REQUIRE_DISTRIBUTED_SESSION_LOCK": "1",
            "KAGECATCH_SESSION_STORE_URL": "https://private-worker.example",
            "KAGECATCH_CORE_SECRET": "s" * 40,
        }
        with patch.dict(os.environ, values, clear=True):
            self.assertEqual(_resolve_session_store_mode(), "d1")


if __name__ == "__main__":
    unittest.main()
