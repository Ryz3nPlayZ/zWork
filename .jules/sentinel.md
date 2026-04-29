## 2025-05-14 - Path Traversal in Static File Serving
**Vulnerability:** The SPA catch-all route in `sidecar/server.py` was vulnerable to path traversal because it concatenated the static directory path with a user-provided path without validation.
**Learning:** Using `pathlib.Path / user_input` is not safe if `user_input` contains `..` sequences or is an absolute path.
**Prevention:** Always `.resolve()` the final path and verify that it starts with the expected base directory using `.relative_to()` or similar prefix checks.
