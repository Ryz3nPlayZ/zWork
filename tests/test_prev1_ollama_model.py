import unittest

from sidecar.agent import providers
from sidecar.agent.settings import Settings


class TestPrev1OllamaModel(unittest.TestCase):
    def test_ollama_cloud_setup_exposes_only_minimax(self) -> None:
        settings = Settings(
            api_keys={"openai": "ollama-test-key"},
            provider_config={"openai": {"base_url": "https://ollama.com/v1"}},
            use_claude_code_config=False,
            default_model="qwen3-5-cloud-ollama",
            custom_models=[
                {
                    "id": "qwen3-5-cloud-ollama",
                    "name": "Qwen 3.5 Cloud",
                    "shape": "openai",
                    "credential": "openai",
                    "model_id": "qwen3.5:cloud",
                    "base_url_override": "https://ollama.com/v1",
                }
            ],
        )

        models = providers.available_models(settings)

        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]["id"], providers.PREV1_OLLAMA_ZWORK_ID)
        self.assertEqual(models[0]["model_id"], providers.PREV1_OLLAMA_MODEL_ID)
        self.assertTrue(models[0]["configured"])

    def test_non_ollama_custom_models_are_left_alone(self) -> None:
        settings = Settings(
            api_keys={"openai": "openai-test-key"},
            provider_config={"openai": {"base_url": "https://api.openai.com/v1"}},
            use_claude_code_config=False,
            custom_models=[
                {
                    "id": "gpt-4o-mini",
                    "name": "GPT-4o mini",
                    "shape": "openai",
                    "credential": "openai",
                    "model_id": "gpt-4o-mini",
                    "base_url_override": "",
                }
            ],
        )

        models = providers.available_models(settings)

        self.assertEqual([m["id"] for m in models], ["gpt-4o-mini"])


if __name__ == "__main__":
    unittest.main()
