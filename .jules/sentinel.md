## 2025-05-15 - Input Validation and SSRF Mitigation
**Vulnerability:** Path traversal via unsanitized identifiers and SSRF via unvalidated Ollama base URLs.
**Learning:** Identifying and chat IDs were used directly in file paths without validation. The Ollama model proxy endpoint accepted any base URL, allowing for SSRF.
**Prevention:** Always validate identifiers against a safe regex (alphanumeric, underscores, hyphens). Whitelist safe domains and private IP ranges for proxy endpoints.

## 2026-05-05 - Regex Newline Bypass in Identifier Validation
**Vulnerability:** Identifier validation used re.match(r"^[a-zA-Z0-9_-]+$") which allows trailing newlines due to the behavior of $ in Python's re module.
**Learning:** In Python, $ matches the end of the string or the position just before a newline at the end of the string. This can allow malicious input to bypass validation if the identifier is used in a context where a newline is significant.
**Prevention:** Use re.fullmatch() or the \Z anchor instead of $ for strict end-of-string matching in security-critical validations.
