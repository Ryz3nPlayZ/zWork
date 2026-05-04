import unittest
from fastapi.testclient import TestClient
from sidecar import server
from sidecar.agent import providers, home

class TestSecurityEnhancements(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(server.app)

    def test_is_safe_ollama_url(self):
        self.assertTrue(providers.is_safe_ollama_url("http://localhost:11434"))
        self.assertTrue(providers.is_safe_ollama_url("http://127.0.0.1:11434"))
        self.assertTrue(providers.is_safe_ollama_url("https://ollama.com/v1"))
        self.assertTrue(providers.is_safe_ollama_url("https://api.ollama.com/v1"))
        self.assertTrue(providers.is_safe_ollama_url("http://192.168.1.1:11434"))
        self.assertTrue(providers.is_safe_ollama_url("http://10.0.0.5:11434"))
        self.assertTrue(providers.is_safe_ollama_url("http://172.16.0.10:11434"))

        self.assertFalse(providers.is_safe_ollama_url("https://evil.com"))
        self.assertFalse(providers.is_safe_ollama_url("http://8.8.8.8"))
        self.assertFalse(providers.is_safe_ollama_url("file:///etc/passwd"))
        self.assertFalse(providers.is_safe_ollama_url("not-a-url"))

    def test_ollama_models_endpoint_ssrf_protection(self):
        # Safe URL
        response = self.client.get("/api/ollama/models?base_url=https://ollama.com/v1")
        # We don't care about the actual result (it might 404 or 500 because it's a real request),
        # but it shouldn't be 400 "unauthorized ollama base_url"
        self.assertNotEqual(response.status_code, 400)

        # Unsafe URL
        response = self.client.get("/api/ollama/models?base_url=https://evil.com/v1")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "unauthorized ollama base_url")

    def test_is_safe_id(self):
        self.assertTrue(home.is_safe_id("valid-id_123"))
        self.assertTrue(home.is_safe_id(None))

        self.assertFalse(home.is_safe_id(""))
        self.assertFalse(home.is_safe_id("invalid id"))
        self.assertFalse(home.is_safe_id("../path/traversal"))
        self.assertFalse(home.is_safe_id("id$with%special*chars"))

    def test_project_routes_id_validation(self):
        # Invalid ID should return 400
        invalid_id = "invalid[id]"

        routes = [
            (self.client.get, f"/api/projects/{invalid_id}"),
            (self.client.patch, f"/api/projects/{invalid_id}"),
            (self.client.delete, f"/api/projects/{invalid_id}"),
            (self.client.get, f"/api/projects/{invalid_id}/context"),
            (self.client.put, f"/api/projects/{invalid_id}/context"),
        ]

        for method, url in routes:
            if method in (self.client.patch, self.client.put):
                response = method(url, json={"content": "test"})
            else:
                response = method(url)
            self.assertEqual(response.status_code, 400, f"Route {url} failed to block invalid ID")
            self.assertEqual(response.json()["detail"], "invalid project_id")

    def test_chat_routes_id_validation(self):
        invalid_id = "chat;drop table chats;"

        routes = [
            (self.client.get, f"/api/chats/{invalid_id}"),
            (self.client.patch, f"/api/chats/{invalid_id}"),
            (self.client.delete, f"/api/chats/{invalid_id}"),
        ]

        for method, url in routes:
            if method == self.client.patch:
                response = method(url, json={"title": "new title"})
            else:
                response = method(url)
            self.assertEqual(response.status_code, 400, f"Route {url} failed to block invalid ID")
            self.assertEqual(response.json()["detail"], "invalid chat_id")

    def test_chat_stream_id_validation(self):
        response = self.client.post("/api/chat/stream", json={
            "chat_id": "../../etc/shadow",
            "message": "hello"
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "invalid chat_id")

if __name__ == "__main__":
    unittest.main()
