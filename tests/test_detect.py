"""Tests for sidecar.agent.detect — local AI tool integration detection."""

from __future__ import annotations

import unittest


class TestDetectAll(unittest.TestCase):
    def _detect(self):
        try:
            from sidecar.agent.detect import detect_all
            return detect_all
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_returns_list(self) -> None:
        fn = self._detect()
        result = fn()
        self.assertIsInstance(result, list)

    def test_all_have_id(self) -> None:
        fn = self._detect()
        for integration in fn():
            self.assertIsInstance(integration.id, str)
            self.assertTrue(integration.id)

    def test_all_have_name(self) -> None:
        fn = self._detect()
        for integration in fn():
            self.assertIsInstance(integration.name, str)
            self.assertTrue(integration.name)

    def test_detected_is_bool(self) -> None:
        fn = self._detect()
        for integration in fn():
            self.assertIsInstance(integration.detected, bool)

    def test_can_reuse_credentials_is_bool(self) -> None:
        fn = self._detect()
        for integration in fn():
            self.assertIsInstance(integration.can_reuse_credentials, bool)

    def test_known_ids_present(self) -> None:
        fn = self._detect()
        ids = {i.id for i in fn()}
        self.assertIn("claude_code", ids)
        self.assertIn("codex", ids)
        self.assertIn("github_copilot", ids)
        self.assertIn("mlx", ids)

    def test_reuse_requires_detection(self) -> None:
        """An integration cannot reuse credentials if it is not detected."""
        fn = self._detect()
        for integration in fn():
            if integration.can_reuse_credentials:
                self.assertTrue(integration.detected)


class TestReadClaudeCodeEnv(unittest.TestCase):
    def test_returns_dict(self) -> None:
        try:
            from sidecar.agent.detect import read_claude_code_env
        except ImportError:
            self.skipTest("sidecar not installed")
        result = read_claude_code_env()
        self.assertIsInstance(result, dict)

    def test_all_values_are_strings(self) -> None:
        try:
            from sidecar.agent.detect import read_claude_code_env
        except ImportError:
            self.skipTest("sidecar not installed")
        result = read_claude_code_env()
        for k, v in result.items():
            self.assertIsInstance(k, str)
            self.assertIsInstance(v, str)


class TestEnvAnthropicCredentials(unittest.TestCase):
    def test_returns_tuple(self) -> None:
        try:
            from sidecar.agent.detect import env_anthropic_credentials
        except ImportError:
            self.skipTest("sidecar not installed")
        result = env_anthropic_credentials()
        self.assertIsInstance(result, tuple)
        self.assertEqual(len(result), 2)

    def test_reads_env_variable(self) -> None:
        try:
            from sidecar.agent.detect import env_anthropic_credentials
        except ImportError:
            self.skipTest("sidecar not installed")
        import os
        old = os.environ.get("ANTHROPIC_API_KEY")
        try:
            os.environ["ANTHROPIC_API_KEY"] = "test-key-123"
            token, _ = env_anthropic_credentials()
            self.assertEqual(token, "test-key-123")
        finally:
            if old is None:
                os.environ.pop("ANTHROPIC_API_KEY", None)
            else:
                os.environ["ANTHROPIC_API_KEY"] = old


if __name__ == "__main__":
    unittest.main()
