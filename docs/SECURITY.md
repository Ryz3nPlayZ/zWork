# zWork Security

This document describes the current security model that is actually wired into the desktop app, the local sidecar, and the cloud services — including accepted risks we have consciously deferred.

## Threat model

The desktop app spawns a local Rust sidecar (Axum, `sidecar-rust/`) on `127.0.0.1:8787`. That sidecar exposes powerful endpoints — most notably `/api/run-python`, which executes arbitrary Python. Because it binds loopback, the primary threats are:

- **Drive-by localhost attacks**: a website open in the user's browser sending requests to `127.0.0.1:8787` (browser context, attacker-controlled origin).
- **Other local processes**: any process running as the same user can connect to loopback directly.

### Sidecar per-run token

At launch the Tauri host (`app/src-tauri/src/main.rs`) mints a random UUID and passes it to the sidecar as `ZWORK_SIDECAR_TOKEN`. An Axum middleware (`require_sidecar_token` in `sidecar-rust/src/main.rs`) rejects any request without a matching `x-zwork-token` header with HTTP 401. The frontend obtains the token through the `get_sidecar_token` Tauri command and sends it on every sidecar request (`app/src/lib/api.ts`).

A website cannot read the token (it lives in the Tauri host process and is only exposed to the app's own webview), and the CORS layer no longer permits arbitrary origins: only `tauri://localhost`, `http(s)://tauri.localhost`, and `chrome-extension://` origins are allowed, with the method/header allowlist the frontend actually uses. Private Network Access (`allow_private_network`) is kept because Chrome requires it for the extension to reach loopback.

If `ZWORK_SIDECAR_TOKEN` is unset (running the binary directly, e.g. local development), the sidecar generates its own per-run token and logs a warning. Note that browser-only dev (`vite dev` without the Tauri host) sends no token, so manual sidecar dev requires pointing requests at the token the sidecar logged, or running via `tauri dev`.

The token authenticates the *caller*, not the *user*: any local process running as the same user could in principle read the sidecar's environment (`/proc`, `ps e`) and recover it. This is accepted for the beta — the goal is defeating remote/drive-by attackers, not a hostile same-user process.

### `/ws` exemption

The `/ws` endpoint (browser bridge, `sidecar-rust/src/browser_bridge.rs`) is exempt from the token middleware. The zbctl Chrome extension connects there and has no way to learn the per-run token. Exposure is bounded: the socket only carries `browser_*` commands to the extension; the extension cannot use it to reach any other endpoint. A malicious page could still open a WebSocket to `/ws` (WebSockets are not CORS-gated) and race the real extension for command delivery — accepted for now, flagged for a future handshake token.

### Secrets at rest

Integration secrets (API keys, OAuth tokens for connected services) are stored plaintext in `secrets.json` under the zWork data dir with file permissions chmod 600 (owner-only). OS keychain migration is deferred until after launch — accepted risk: any process running as the same user can read the file.

### Cloud bearer token

Cloud sign-in yields a 30-day bearer token stored in the webview's `localStorage` (`zwork:cloud-token`). Accepted for beta: the webview CSP restricts script sources to `'self'`, and the token can be revoked server-side. Refresh-token rotation and shorter lifetimes are post-launch work.

### Port cleanup (`kill_stale_on_port`)

On startup and backend restart, the Tauri host kills stale processes bound to port 8787. It only SIGKILLs PIDs whose process command contains `zwork-backend` — an earlier version killed whatever held the port, which could take out an unrelated user process.

### Localhost auth callback nonce

Desktop sign-in listens on an ephemeral localhost port for the OAuth callback. The Tauri host generates a nonce per attempt, sends it as `&nonce=` on the auth start URL, and the cloud API round-trips it inside the OAuth `state` and echoes it back on the `http://127.0.0.1:<port>/callback` redirect. Callbacks whose nonce doesn't match are rejected, so another local process (or a website redirected to the listener) cannot inject its own auth code into an in-flight sign-in. The acceptance window is also bounded to 240 seconds.
