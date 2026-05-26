"""Tests for sidecar package version resolution."""

from __future__ import annotations

import unittest


class TestVersion(unittest.TestCase):
    def test_version_is_string(self) -> None:
        try:
            from sidecar import __version__
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertIsInstance(__version__, str)

    def test_version_non_empty(self) -> None:
        try:
            from sidecar import __version__
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertTrue(__version__)

    def test_version_has_numeric_prefix(self) -> None:
        try:
            from sidecar import __version__
        except ImportError:
            self.skipTest("sidecar not installed")
        # Should start with a digit (e.g. "0.4.0-alpha.17")
        self.assertTrue(__version__[0].isdigit(), repr(__version__))

    def test_version_contains_dot(self) -> None:
        try:
            from sidecar import __version__
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertIn(".", __version__)


if __name__ == "__main__":
    unittest.main()
