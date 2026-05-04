"""Tests for the SSRF guard on /api/ollama/models."""
import unittest

from sidecar.server import _safe_proxy_base_url


class TestSafeProxyBaseUrl(unittest.TestCase):
    def test_accepts_public_https(self) -> None:
        self.assertEqual(
            _safe_proxy_base_url("https://ollama.com/v1"),
            "https://ollama.com/v1",
        )

    def test_strips_trailing_slash(self) -> None:
        self.assertEqual(
            _safe_proxy_base_url("https://ollama.com/v1/"),
            "https://ollama.com/v1",
        )

    def test_accepts_loopback_for_self_hosted(self) -> None:
        for url in (
            "http://127.0.0.1:11434/v1",
            "http://localhost:11434/v1",
            "http://[::1]:11434/v1",
        ):
            self.assertEqual(_safe_proxy_base_url(url), url)

    def test_rejects_non_http_scheme(self) -> None:
        for url in ("file:///etc/passwd", "ftp://example.com", "javascript:alert(1)"):
            with self.assertRaises(ValueError):
                _safe_proxy_base_url(url)

    def test_rejects_missing_host(self) -> None:
        with self.assertRaises(ValueError):
            _safe_proxy_base_url("http:///models")

    def test_rejects_private_ipv4(self) -> None:
        for host in ("10.0.0.1", "192.168.1.1", "172.16.0.1"):
            with self.assertRaises(ValueError):
                _safe_proxy_base_url(f"http://{host}/v1")

    def test_rejects_link_local_metadata(self) -> None:
        # The classic SSRF target — AWS / GCP / Azure metadata endpoint.
        with self.assertRaises(ValueError):
            _safe_proxy_base_url("http://169.254.169.254/latest/meta-data/")

    def test_rejects_ipv4_mapped_ipv6_private(self) -> None:
        # IPv4-mapped IPv6 form of a private address — the `ipaddress` module
        # exposes `is_private` for these so the check still trips.
        with self.assertRaises(ValueError):
            _safe_proxy_base_url("http://[::ffff:192.168.0.1]/v1")

    def test_rejects_unspecified(self) -> None:
        with self.assertRaises(ValueError):
            _safe_proxy_base_url("http://0.0.0.0/v1")


if __name__ == "__main__":
    unittest.main()
