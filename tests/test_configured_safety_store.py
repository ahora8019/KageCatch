"""Configured runtime must never start distributed sessions with ephemeral safety locks."""
import os
import unittest
from unittest.mock import patch

from kagecatch.core_api import _configured_runtime


class ConfiguredSafetyStoreTests(unittest.TestCase):
    def test_distributed_runtime_fails_closed_until_shared_safety_store_exists(self):
        environment = {
            "KAGECATCH_SESSION_STORE_URL": "https://control.example.workers.dev",
            "KAGECATCH_CORE_SECRET": "x" * 40,
            "KAGECATCH_API_ID": "12345",
            "KAGECATCH_API_HASH": "test-api-hash",
            "KAGECATCH_FERNET_KEY": "not-used-in-this-test",
            "RENDER": "1",
        }
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "shared durable Telegram safety state"):
                _configured_runtime()


if __name__ == "__main__":
    unittest.main()
