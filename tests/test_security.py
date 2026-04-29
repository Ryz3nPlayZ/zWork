import unittest
import os
import tempfile
import re
from pathlib import Path

# The enumeration-based fix
def simulate_serve_spa_logic(_STATIC_DIR, path):
    # Only serve files directly in the root of _STATIC_DIR.
    # We iterate over the directory to ensure the served path originates from the filesystem.
    if path and "/" not in path and "\\" not in path and ".." not in path:
        if _STATIC_DIR.exists() and _STATIC_DIR.is_dir():
            for entry in _STATIC_DIR.iterdir():
                if entry.is_file() and entry.name == path:
                    return entry

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

if __name__ == "__main__":
    unittest.main()
