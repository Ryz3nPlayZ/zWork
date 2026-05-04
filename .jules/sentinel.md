## 2025-05-15 - Input Validation and SSRF Mitigation
**Vulnerability:** Path traversal via unsanitized identifiers and SSRF via unvalidated Ollama base URLs.
**Learning:** Identifying and chat IDs were used directly in file paths without validation. The Ollama model proxy endpoint accepted any base URL, allowing for SSRF.
**Prevention:** Always validate identifiers against a safe regex (alphanumeric, underscores, hyphens). Whitelist safe domains and private IP ranges for proxy endpoints.
