"""Tests for the MLX runtime integration detector."""
import unittest
from unittest.mock import patch

from sidecar.agent import detect


class TestMlxDetection(unittest.TestCase):
    @patch("sidecar.agent.detect.platform.system", return_value="Linux")
    @patch("sidecar.agent.detect.platform.machine", return_value="x86_64")
    def test_not_apple_silicon(self, *_) -> None:
        i = detect._mlx()
        self.assertFalse(i.detected)
        self.assertIn("Apple Silicon", i.detail)
        self.assertEqual(i.path, "")

    @patch("sidecar.agent.detect.platform.system", return_value="Darwin")
    @patch("sidecar.agent.detect.platform.machine", return_value="x86_64")
    def test_intel_mac_not_supported(self, *_) -> None:
        # Intel Macs can install mlx-lm but it won't actually run on the
        # Neural Engine — flag it as unsupported so users don't get a
        # confusing slow-CPU experience.
        i = detect._mlx()
        self.assertFalse(i.detected)
        self.assertIn("Apple Silicon", i.detail)

    @patch("sidecar.agent.detect.shutil.which", return_value=None)
    @patch("sidecar.agent.detect.platform.system", return_value="Darwin")
    @patch("sidecar.agent.detect.platform.machine", return_value="arm64")
    def test_apple_silicon_no_binary(self, *_) -> None:
        i = detect._mlx()
        self.assertFalse(i.detected)
        self.assertIn("pip install mlx-lm", i.detail)

    @patch("sidecar.agent.detect.shutil.which", return_value="/opt/homebrew/bin/mlx_lm.server")
    @patch("sidecar.agent.detect.platform.system", return_value="Darwin")
    @patch("sidecar.agent.detect.platform.machine", return_value="arm64")
    def test_apple_silicon_with_binary(self, *_) -> None:
        i = detect._mlx()
        self.assertTrue(i.detected)
        self.assertEqual(i.path, "/opt/homebrew/bin/mlx_lm.server")
        # The detail should include the start command and the local base_url
        # so the integrations panel can show a one-line hint.
        self.assertIn("mlx_lm.server", i.detail)
        self.assertIn("localhost:8080/v1", i.detail)

    def test_detect_all_includes_mlx(self) -> None:
        ids = [i.id for i in detect.detect_all()]
        self.assertIn("mlx", ids)


if __name__ == "__main__":
    unittest.main()
