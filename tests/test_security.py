import unittest
import os
import tempfile
import asyncio
from pathlib import Path
from fastapi.staticfiles import StaticFiles
from fastapi import Request
from starlette.responses import FileResponse

# The StaticFiles-based fix
async def simulate_serve_spa_logic(_STATIC_DIR, _static_app, path, scope):
    # Only serve files directly in the root of _STATIC_DIR.
    if _static_app and path and "/" not in path and "\\" not in path and ".." not in path:
        try:
            # We must use a full scope for StaticFiles.get_response
            full_scope = {
                "type": "http",
                "method": "GET",
                "path": "/" + path,
                "root_path": "",
                "headers": [],
            }
            resp = await _static_app.get_response(path, full_scope)
            if resp.status_code == 200:
                return resp
        except Exception as e:
            print(f"Exception in get_response: {e}")
            pass

    return FileResponse(_STATIC_DIR / "index.html")

class TestPathTraversal(unittest.IsolatedAsyncioTestCase):
    async def test_serve_spa_traversal(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir).resolve()
            static_dir = tmp_path / "app" / "dist"
            static_dir.mkdir(parents=True)

            index_file = static_dir / "index.html"
            index_file.write_text("index")

            # A legitimate file in the root
            favicon = static_dir / "favicon.ico"
            favicon.write_text("icon")

            secret_file = tmp_path / "secret.txt"
            secret_file.write_text("secret_content")

            static_app = StaticFiles(directory=static_dir)
            scope = {"type": "http", "method": "GET"}

            # Normal root file request
            res = await simulate_serve_spa_logic(static_dir, static_app, "favicon.ico", scope)
            self.assertEqual(res.status_code, 200)
            self.assertEqual(Path(res.path).resolve(), favicon.resolve())

            # Normal SPA route request
            res = await simulate_serve_spa_logic(static_dir, static_app, "chat/123", scope)
            self.assertEqual(Path(res.path).resolve(), index_file.resolve())

            # Traversal request (dot-dot)
            traversal_path = "../../secret.txt"
            res = await simulate_serve_spa_logic(static_dir, static_app, traversal_path, scope)
            self.assertEqual(Path(res.path).resolve(), index_file.resolve(), "Path traversal with .. should be blocked")

            # Absolute path request
            abs_path = str(secret_file)
            res = await simulate_serve_spa_logic(static_dir, static_app, abs_path, scope)
            self.assertEqual(Path(res.path).resolve(), index_file.resolve(), "Path traversal with absolute path should be blocked")

if __name__ == "__main__":
    unittest.main()
