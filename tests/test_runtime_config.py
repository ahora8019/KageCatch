import importlib.util
import os
import unittest
from unittest.mock import patch

from kagecatch.core_api import _configuration_presence


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
            "telethon_available": importlib.util.find_spec("telethon") is not None,
        })

    def test_configuration_report_marks_d1_session_store_url_without_exposing_it(self):
        with patch.dict(os.environ, {"KAGECATCH_SESSION_STORE_URL": "https://private-worker.example"}, clear=True):
            report = _configuration_presence()

        self.assertTrue(report["session_store_url_configured"])
        self.assertNotIn("private-worker.example", repr(report))


if __name__ == "__main__":
    unittest.main()
