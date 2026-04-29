import unittest
import os
import tempfile
from pathlib import Path

# The fix we applied
def simulate_serve_spa_logic(_STATIC_DIR, path):
    # This matches the FIXED implementation in sidecar/server.py
    candidate = (_STATIC_DIR / path).resolve()
    try:
        # Check if candidate is still under _STATIC_DIR
        candidate.relative_to(_STATIC_DIR.resolve())
        if path and candidate.is_file():
            return candidate
    except ValueError:
        # path is outside of _STATIC_DIR
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

            # Traversal request
            traversal_path = "../../secret.txt"
            res = simulate_serve_spa_logic(static_dir, traversal_path)

            # It should NOT be the secret file, it should be index.html
            self.assertEqual(res, index_file, "Path traversal should be blocked and return index.html")

            # Subdirectory request
            assets_dir = static_dir / "assets"
            assets_dir.mkdir()
            logo_file = assets_dir / "logo.png"
            logo_file.write_text("logo")

            res = simulate_serve_spa_logic(static_dir, "assets/logo.png")
            self.assertEqual(res, logo_file)

if __name__ == "__main__":
    unittest.main()
