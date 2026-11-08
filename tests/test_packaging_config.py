import tomllib
from pathlib import Path
import unittest


class PackagingConfigTests(unittest.TestCase):
    def test_api_extra_installs_telethon_used_by_runtime_auth_flow(self):
        project = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
        api_dependencies = project["project"]["optional-dependencies"]["api"]
        self.assertTrue(
            any(item.lower().startswith("telethon") for item in api_dependencies),
            "the Render API install extra must include Telethon because core_api imports the Telegram authorization flow",
        )


if __name__ == "__main__":
    unittest.main()
