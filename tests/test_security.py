import unittest
import os
import tempfile
import re
from pathlib import Path

# The simplified, extra-safe fix
def simulate_serve_spa_logic(_STATIC_DIR, path):
    # Only serve files directly in the root of _STATIC_DIR.
    # SPA routes or nested paths (not handled by /assets) should serve index.html.
    if path and "/" not in path and "\\" not in path and ".." not in path:
        candidate = _STATIC_DIR / path
        if candidate.is_file():
            return candidate

    return _STATIC_DIR / "index.html"

class TestPathTraversal(unittest.TestCase):
    def test_serve_spa_traversal(self):
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

            # Normal root file request
            res = simulate_serve_spa_logic(static_dir, "favicon.ico")
            self.assertEqual(res, favicon)

            # Normal SPA route request
            res = simulate_serve_spa_logic(static_dir, "chat/123")
            self.assertEqual(res, index_file)

            # Traversal request (dot-dot)
            traversal_path = "../../secret.txt"
            res = simulate_serve_spa_logic(static_dir, traversal_path)
            self.assertEqual(res, index_file, "Path traversal with .. should be blocked")

            # Absolute path request
            abs_path = str(secret_file)
            res = simulate_serve_spa_logic(static_dir, abs_path)
            self.assertEqual(res, index_file, "Path traversal with absolute path should be blocked")

            # Backslash request
            res = simulate_serve_spa_logic(static_dir, "assets\\..\\..\\secret.txt")
            self.assertEqual(res, index_file, "Path traversal with backslashes should be blocked")

if __name__ == "__main__":
    unittest.main()
