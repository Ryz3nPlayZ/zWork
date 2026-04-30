## 2025-05-14 - Restrictive CORS configuration
**Vulnerability:** Permissive CORS configuration (`allow_origin_regex=".*"`) in `sidecar/server.py` allowed any origin to make requests to the backend API.
**Learning:** While the backend was bound to `127.0.0.1`, a permissive CORS policy still allows malicious websites visited by the user in a browser to interact with the local API if they can guess or discover the port. In this case, since the app is a Tauri application, it only needs to communicate with its own UI origins.
**Prevention:** Always use the principle of least privilege for CORS. Only allow known origins like `tauri://localhost`, `http://tauri.localhost`, and `http://localhost:1420` (for development). Avoid using wildcards or overly permissive regexes.
