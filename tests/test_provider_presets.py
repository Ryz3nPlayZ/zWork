"""Tests for the native OpenAI-compatible provider presets."""
import unittest
from unittest.mock import patch

from sidecar.agent import providers
from sidecar.agent.providers import OPENAI_COMPAT_PROVIDERS, resolve
from sidecar.agent.settings import KNOWN_CREDENTIALS, Settings, upsert_custom_model


class TestProviderPresets(unittest.TestCase):
    def test_all_presets_in_known_credentials(self) -> None:
        # Anything in OPENAI_COMPAT_PROVIDERS must also be a valid credential
        # for upsert_custom_model. Catching this drift here instead of at
        # runtime when a user tries to add a Groq model.
        for name in OPENAI_COMPAT_PROVIDERS:
            self.assertIn(name, KNOWN_CREDENTIALS, f"missing: {name}")

    def test_resolve_groq_with_byok_key(self) -> None:
        s = Settings(api_keys={"groq": "gsk_test123"})
        c = resolve("groq", s)
        self.assertIsNotNone(c)
        assert c is not None  # for type checker
        self.assertEqual(c.shape, "openai")
        self.assertEqual(c.api_key, "gsk_test123")
        self.assertEqual(c.base_url, "https://api.groq.com/openai/v1")
        self.assertEqual(c.source, "byok")

    def test_resolve_cerebras_with_base_url_override(self) -> None:
        s = Settings(
            api_keys={"cerebras": "csk-abc"},
            provider_config={"cerebras": {"base_url": "https://eu.cerebras.ai/v1"}},
        )
        c = resolve("cerebras", s)
        assert c is not None
        self.assertEqual(c.base_url, "https://eu.cerebras.ai/v1")

    def test_resolve_deepseek_falls_back_to_env(self) -> None:
        s = Settings()  # no api_keys
        with patch.dict("os.environ", {"DEEPSEEK_API_KEY": "envkey"}):
            c = resolve("deepseek", s)
        assert c is not None
        self.assertEqual(c.api_key, "envkey")
        self.assertEqual(c.base_url, "https://api.deepseek.com/v1")
        self.assertEqual(c.source, "env")

    def test_resolve_zai_default_base_url(self) -> None:
        s = Settings(api_keys={"zai": "zaikey"})
        c = resolve("zai", s)
        assert c is not None
        self.assertEqual(c.base_url, "https://api.z.ai/api/paas/v4")

    def test_resolve_returns_none_when_unconfigured(self) -> None:
        s = Settings()
        with patch.dict("os.environ", {}, clear=True):
            self.assertIsNone(resolve("groq", s))
            self.assertIsNone(resolve("cerebras", s))
            self.assertIsNone(resolve("deepseek", s))
            self.assertIsNone(resolve("zai", s))

    def test_credential_status_includes_new_providers(self) -> None:
        s = Settings(api_keys={"groq": "gsk_x"})
        status = providers.credential_status(s)
        for name in ("groq", "cerebras", "deepseek", "zai"):
            self.assertIn(name, status)
        self.assertTrue(status["groq"]["configured"])
        self.assertFalse(status["cerebras"]["configured"])
        self.assertEqual(status["groq"]["shape"], "openai")

    def test_upsert_custom_model_accepts_new_credentials(self) -> None:
        s = Settings()
        for cred in ("groq", "cerebras", "deepseek", "zai"):
            m = upsert_custom_model(
                s,
                id=None,
                name=f"{cred}-test",
                shape="openai",
                credential=cred,
                model_id="some-model",
            )
            self.assertEqual(m.credential, cred)

    def test_upsert_custom_model_rejects_unknown_credential(self) -> None:
        s = Settings()
        with self.assertRaises(ValueError) as ctx:
            upsert_custom_model(
                s,
                id=None,
                name="x",
                shape="openai",
                credential="bogus_provider",
                model_id="x",
            )
        self.assertIn("must be one of", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
