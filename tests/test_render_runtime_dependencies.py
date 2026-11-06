"""Deployment dependency contract for the Render Python Core."""
import tomllib
import unittest
from pathlib import Path


class RenderRuntimeDependencyTests(unittest.TestCase):
    def test_api_extra_installs_telethon_used_by_phone_auth_flow(self):
        project = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
        api_dependencies = project["project"]["optional-dependencies"]["api"]
        self.assertTrue(
            any(dependency.lower().startswith("telethon") for dependency in api_dependencies),
            "Render installs the [api] extra, so it must include Telethon for account authorization.",
        )


if __name__ == "__main__":
    unittest.main()
