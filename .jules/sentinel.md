## 2025-05-15 - Path Traversal in Internal Identifiers
**Vulnerability:** Internal identifiers (project_id, chat_id) were used directly to construct file system paths without validation, enabling directory traversal via `..` sequences.
**Learning:** Even internal identifiers that are assumed to be safe (like UUIDs or slugs) can be manipulated if they are passed from the client and used in path construction. A strict allowlist is the most reliable defense.
**Prevention:** Use a centralized validation helper (e.g., `is_safe_id`) with a strict regular expression (`^[a-zA-Z0-9_-]+$`) for all identifiers used in file operations. Disallow dots and slashes entirely.
