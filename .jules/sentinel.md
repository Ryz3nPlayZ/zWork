## 2025-05-15 - Path Traversal in Project and Chat IDs

**Vulnerability:** API endpoints for projects and chats used user-supplied IDs to construct filesystem paths without validation, allowing path traversal (e.g., using `..` to access or modify files outside the intended directories).

**Learning:** When using identifiers to build file paths, always validate them against a strict whitelist of allowed characters. Relying on FastAPI's path parameter handling is not enough if the ID is later used in `os.path.join` or `Path / id`.

**Prevention:** Use a regex-based helper like `is_safe_id` to validate all internal identifiers before they reach the filesystem layer.
