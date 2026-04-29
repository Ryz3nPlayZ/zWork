import unittest
import os
import tempfile
from pathlib import Path

# The fix we applied
def simulate_serve_spa_logic(_STATIC_DIR, path):
    # This matches the FIXED implementation in sidecar/server.py
    # First, sanitize input to block obvious traversal attempts.
    if ".." in path or path.startswith("/") or "\\" in path:
        return _STATIC_DIR / "index.html"

    # Then, verify the resolved path remains under the static directory.
    try:
        candidate = (_STATIC_DIR / path).resolve()
        if candidate.is_file() and os.path.commonpath([_STATIC_DIR.resolve(), candidate]) == str(_STATIC_DIR.resolve()):
            return candidate
    except (ValueError, OSError):
        pass

    # Fall back to index.html for SPA routing.
    return _STATIC_DIR / "index.html"

class TestPathTraversal(unittest.TestCase):
    def test_serve_spa_traversal(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir).resolve()
            static_dir = tmp_path / "app" / "dist"
            static_dir.mkdir(parents=True)

            index_file = static_dir / "index.html"
            index_file.write_text("index")

            secret_file = tmp_path / "secret.txt"
            secret_file.write_text("secret_content")

            # Normal request
            res = simulate_serve_spa_logic(static_dir, "index.html")
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

            # Subdirectory request
            assets_dir = static_dir / "assets"
            assets_dir.mkdir()
            logo_file = assets_dir / "logo.png"
            logo_file.write_text("logo")

            res = simulate_serve_spa_logic(static_dir, "assets/logo.png")
            self.assertEqual(res, logo_file)

if __name__ == "__main__":
    unittest.main()
