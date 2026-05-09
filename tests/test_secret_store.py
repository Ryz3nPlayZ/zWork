import json
import os
import tempfile
import unittest
from pathlib import Path

from sidecar.agent.settings import Settings, load, save


class TestSecretStoreMigration(unittest.TestCase):
    def test_api_keys_move_out_of_settings_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            old_home = os.environ.get("ZWORK_HOME")
            old_store = os.environ.get("ZWORK_SECRET_STORE")
            try:
                os.environ["ZWORK_HOME"] = tmp
                os.environ["ZWORK_SECRET_STORE"] = "file"

                settings = Settings(
                    api_keys={
                        "anthropic": "anthropic-secret",
                        "openai": "openai-secret",
                    },
                    provider_config={
                        "anthropic": {"base_url": "https://api.anthropic.com"},
                        "openai": {"base_url": "https://api.openai.com/v1"},
                    },
                )
                save(settings)

                settings_path = Path(tmp) / "settings.json"
                secrets_path = Path(tmp) / "secrets.json"

                on_disk = json.loads(settings_path.read_text(encoding="utf-8"))
                self.assertEqual(on_disk.get("api_keys"), {"anthropic": "", "openai": ""})

                secrets = json.loads(secrets_path.read_text(encoding="utf-8"))
                self.assertEqual(
                    secrets.get("api_keys"),
                    {
                        "anthropic": "anthropic-secret",
                        "openai": "openai-secret",
                    },
                )

                loaded = load()
                self.assertEqual(
                    loaded.api_keys,
                    {
                        "anthropic": "anthropic-secret",
                        "openai": "openai-secret",
                    },
                )
                self.assertEqual(loaded.provider_config["openai"]["base_url"], "https://api.openai.com/v1")
            finally:
                if old_home is None:
                    os.environ.pop("ZWORK_HOME", None)
                else:
                    os.environ["ZWORK_HOME"] = old_home
                if old_store is None:
                    os.environ.pop("ZWORK_SECRET_STORE", None)
                else:
                    os.environ["ZWORK_SECRET_STORE"] = old_store


if __name__ == "__main__":
    unittest.main()
