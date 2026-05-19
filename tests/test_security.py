import tempfile
import unittest
from pathlib import Path

from fastapi import Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.testclient import TestClient

from sidecar import server


class TestServerSecurity(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(server.app)

    def test_cors_allows_desktop_and_dev_origins(self) -> None:
        response = self.client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:1420",
                "Access-Control-Request-Method": "GET",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "http://localhost:1420",
        )

    def test_cors_blocks_untrusted_origin(self) -> None:
        response = self.client.options(
            "/api/health",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "GET",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(response.headers.get("access-control-allow-origin"))

    def test_spa_catch_all_rejects_parent_directory_escape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            static_root = Path(tmp)
            outside = static_root.parent / "secret.txt"
            index_path = static_root / "index.html"
            asset_path = static_root / "favicon.ico"

            outside.write_text("do not expose", encoding="utf-8")
            index_path.write_text("<html>ok</html>", encoding="utf-8")
            asset_path.write_text("icon", encoding="utf-8")

            original_static_dir = server._STATIC_DIR
            server._STATIC_DIR = static_root

            # Register SPA catch-all route if it wasn't registered at import
            # (e.g. in CI where app/dist doesn't exist).
            route_registered = any(
                r.path == "/{path:path}" for r in server.app.routes
            )
            if not route_registered:

                @server.app.get("/{path:path}")
                async def serve_spa(request: Request, path: str) -> HTMLResponse:
                    if path:
                        normalized = Path(path.lstrip("/"))
                        if not normalized.is_absolute() and ".." not in normalized.parts and "\\" not in path:
                            sr = server._STATIC_DIR.resolve()
                            candidate = (sr / normalized).resolve()
                            try:
                                candidate.relative_to(sr)
                            except ValueError:
                                candidate = None
                            if candidate is not None and candidate.is_file():
                                return FileResponse(candidate)
                    return FileResponse(server._STATIC_DIR / "index.html")

            try:
                allowed = self.client.get("/favicon.ico")
                self.assertEqual(allowed.status_code, 200)
                self.assertEqual(allowed.text, "icon")

                escaped = self.client.get("/../secret.txt")
                self.assertEqual(escaped.status_code, 200)
                self.assertEqual(escaped.text, "<html>ok</html>")
                self.assertNotIn("do not expose", escaped.text)
            finally:
                server._STATIC_DIR = original_static_dir


if __name__ == "__main__":
    unittest.main()
