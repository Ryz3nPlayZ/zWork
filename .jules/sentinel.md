## 2025-05-02 - SSRF and Path Traversal Vulnerabilities
**Vulnerability:** The `/api/ollama/models` endpoint allowed arbitrary `base_url` values, leading to SSRF. Multiple project and chat endpoints used user-controlled IDs in file paths without validation, leading to path traversal risks.
**Learning:** FastAPI path parameters aren't inherently safe if they are later used to construct file system paths. Always validate identifiers against a strict allowed-character set.
**Prevention:** Use a centralized identifier validation helper like `is_safe_id`. Whitelist allowed domains/hosts for any proxy-like functionality.
