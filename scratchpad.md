# zWork Session Scratchpad — 2026-06-20

## Server fixes

- Fixed `ssh-connect.sh` tilde-expansion bug (`~/.ssh/zwork-server` was not expanding; switched to `${HOME}`).
- SSH'd into `api.tryzwork.app` properly.
- Diagnosed Gemma 4 31b Cloud failure: `OLLAMA_MODEL_1=gemma4:31b-cloud` was wrong; Ollama Cloud lists it as `gemma4:31b`.
- Updated `~/cloud/.env` and deployed `~/cloud/api/src/main.rs`:
  - `ALLOWED_MODELS`, `PRO_ONLY_MODELS`, `zwork-vision` alias, default fallback all changed from `gemma4:31b-cloud` → `gemma4:31b`.
- Rebuilt/restarted the `cloud-axum_api-1` Docker container on the server.
- Mirrored the same model-ID fixes in repo source: `cloud-src/api/src/main.rs`.

## Hermes agent investigation

- Hermes is already running on the server under `~/.hermes/` with its own gateway.
- Key patterns to borrow:
  - `~/.hermes/memories/USER.md` — user profile facts.
  - `~/.hermes/memories/MEMORY.md` — general agent observations.
  - Entries separated by `§` on its own line.
  - `SOUL.md` for persona, channel directory for contacts, cron scheduler for proactive runs.
- Telegram is already configured in Hermes (`telegram` channel for Zemu Liu).

## Implemented in Rust sidecar (`sidecar-rust/`)

### 1. Markdown-based memory system (`src/memory.rs`)

- `~/.zwork/memories/USER.md` — user facts.
- `~/.zwork/memories/MEMORY.md` — general facts.
- `§` delimiter between entries (Hermes/Karpathy style).
- Character budgets: 1375 for USER, 2200 for MEMORY.
- Backward compatibility: falls back to legacy `~/.zwork/memory.md` if new files are empty.
- `save_memory(content, target?)` updated:
  - `target="user"` writes to USER.md.
  - `target="memory"` writes to MEMORY.md (default).

### 2. Timeline / time awareness (`src/memory.rs`)

- `build_timeline_block()` injects current time, today, yesterday, tomorrow, this week, next week into the system prompt.
- Agent can now accurately reference "yesterday", "this week", etc.

### 3. Capability differentiation (`src/settings.rs`)

- New system-prompt section: "Know what you can and cannot do".
- Categories:
  - Directly actionable on this computer → do it.
  - Missing setup → explain and offer to configure.
  - Human-only → hand off clearly.
  - Future/recurring → schedule/remind.

### 4. Vision attachments wired end-to-end

- `ChatStreamRequest` now accepts `attachments`.
- `agent/prompts.rs::build_user_content()` builds Anthropic content blocks from text + attachments.
- Images are base64-encoded into `image` blocks.
- Non-image attachments become text references for `read_file`/`extract_document`.
- `convert_convo_for_openai()` translates Anthropic image blocks to OpenAI `image_url` blocks.
- Fixed `/api/uploads` response to include `path` so the frontend's `uploadedPath` is populated.

### 5. Telegram bridge (`src/telegram.rs`)

- Added `telegram` to `KNOWN_CREDENTIALS` (bot token goes through secret store).
- Added `telegram_chat_id` to Settings.
- New endpoint: `POST /api/telegram/send { text }`.
- New tool: `send_telegram_message(text)`.
- Configure via `PUT /api/settings`:
  ```json
  {
    "api_keys": { "telegram": "YOUR_BOT_TOKEN" },
    "telegram_chat_id": "YOUR_CHAT_ID"
  }
  ```

## Build status

- `sidecar-rust`: `cargo build` succeeds.
- `app`: `npm run build` succeeds.
- `cloud-src/api`: `cargo check` succeeds.

## Known limitations / next steps

- Web mode (`streamChatWeb`) still ignores attachments; desktop/Tauri mode is the one that now supports vision.
- Telegram is send-only. Receiving messages and routing them into the agent loop (Hermes-style bidirectional gateway) is not yet implemented.
- Proactive scheduler / heartbeat is still missing; this is the core of "do things before you ask".
- No UI controls for Telegram config yet — only API/settings-file configuration.

---

# zWork Session Scratchpad — 2026-06-24 (continued)

## "sidecar-app" name in macOS permission prompts

- Diagnosed: the Tauri shell executable is literally named `sidecar-app` (the Rust crate name in `app/src-tauri/Cargo.toml` — a leftover from the Python-sidecar era). The bundle display name is correctly `zWork`, but unsigned apps (zWork is curl-installed, no signing/notarization) show the raw executable name in TCC prompts / System Settings.
- Also noted: zWork requests its OWN Accessibility on launch because it registers a global hotkey (Control+Alt+Space overlay) via `tauri-plugin-global-shortcut` at startup (`app/src-tauri/src/main.rs`). This is a separate grant from the CuaDriver one.

### Fix (in code, uncommitted)
- `app/src-tauri/Cargo.toml`: `[package] name` and `[[bin]] name` `sidecar-app` → `zwork`; description → "zWork desktop assistant".
- `scripts/package-release.sh`: Linux AppImage icon symlink `sidecar-app.png` → `zwork.png`.
- Caveat: the prompt will read `zwork` (lowercase); exact-case `zWork` in the TCC prompt ultimately needs code signing (still parked).

## Infinite "record screen and audio" permission-prompt loop

- Symptom: opening Settings triggered repeated Screen Recording + audio prompts.
- Root cause: the Settings page polls `/api/desktop/status` every ~2s → `check_permissions(false)` → `client()` → **launched + cached the CuaDriver daemon** → the daemon's screen-capture stream (ScreenCaptureKit: screen + audio) re-prompts every cycle while ungranted = infinite loop.
- Verified: zero media/audio/microphone capture code in frontend OR backend. Prompts are attributed to `com.trycua.driver`, not zWork.

### Fix (`sidecar-rust/src/cua/mod.rs`, uncommitted, `cargo check` passes)
- Added `static LAST_PERMS: Mutex<Option<PermissionStatus>>` (cached permission state).
- New helper `read_and_cache_perms(prompt)` — live MCP read + cache.
- `check_permissions(false)` (read-only status) now returns the cached / "CuaDriver isn't running" state **without launching the daemon** → polling can never trigger the loop.
- `check_permissions(true)` (Grant button) still launches + raises prompts + caches (deliberate, one-shot).
- `start_session()` now refreshes the cache while the daemon is legitimately up for a real desktop task.
- Residual risk: Grant leaves the daemon cached until idle teardown (default `ZWORK_IDLE_TEARDOWN_SECS` = 1800); clicking Grant without granting + walking away could re-prompt for up to that window. Deeper harden (register-then-stop + deep-link to System Settings, like `requestScreenRecording` already does) deferred.

### Immediate workaround (no rebuild needed)
- Grant Screen Recording to **CuaDriver** in System Settings → Privacy & Security → Screen Recording. The stream then succeeds and stops re-prompting even on the currently-installed build.
- `pkill -f CuaDriver` / quit zWork also stops it.

## Overlay (Ctrl+Alt+Space) rebuild — diagnosed, NOT yet implemented

User decided to rebuild it properly (not remove). Root causes found; no overlay code written yet (paused for the prompt fix):

- **Can't move it:** `.titlebar-drag` uses `-webkit-app-region: drag` (`app/src/index.css:158`), which is Electron/Chrome-only — a complete no-op in Tauri's WKWebView. Plus `overlayGeometry.ts::fitOverlayWindow` force-recenters the window on every render. Fix: drive drag via `getCurrentWindow().startDragging()` and stop recentering; persist `{x,y}` via `onMoved` to localStorage.
- **Dark rectangle:** `body { @apply bg-paper }` (`app/src/index.css:98`) leaks; the overlay only sets html/body transparent (not `#root`), and the borderless window keeps a default shadow. Fix: force transparent chrome via an `overlay-window` class on `<html>`, set window `shadow:false`, drop `backdrop-blur-xl` from the chat panel.
- **Can't type / useless:** the overlay textarea is hard-capped `max-h-[48px]` (`app/src/components/ChatInput.tsx:602`) and the window is `resizable:false`; it only expands to 640px AFTER sending. Fix: remove the cap, report textarea height up, auto-grow the window (top-left preserved, clamped to the work area).

Files to touch when implementing: `app/src-tauri/tauri.conf.json`, `app/src/index.css`, `app/src/lib/overlayGeometry.ts`, `app/src/components/OverlayChatView.tsx`, `app/src/components/ChatInput.tsx`.

## Session notes

- Everything this session is **uncommitted** on `feat/rust-backend-rewrite`; nothing tagged. The prior alpha.16 work (Python removal, permission UI rework, browser-bridge fallback + status endpoint, docs) is also still uncommitted.
- **Antigravity** (Google agentic IDE) is also running on this machine and is another screen/audio-capturing agent — if prompts return while zWork is closed, check whether the dialog names CuaDriver or Antigravity.
- Saved a memory of the prompt-loop finding: `permission-poll-launches-cuadriver.md`.


---

# zWork Session Scratchpad — 2026-06-20 (zwork-vision focus)

## Goal

Fully implement and integrate `zwork-vision` (Gemma 4 31B via Ollama Cloud) end-to-end.

## What was missing / diagnosed

1. `zwork-vision` was not exposed in the frontend model picker or onboarding.
2. The desktop Rust sidecar accepted attachments but never wired them into the LLM request.
3. The frontend upload response didn't include `path`, so `uploadedPath` was undefined and attachments were dropped.
4. Web mode always used Anthropic `/api/v1/messages`, which only routes to Anthropic-protocol gateway providers. Ollama Cloud is configured as `GatewayProtocol::OpenAi`, so web-mode `zwork-vision` requests would never reach it.

## Changes made

### Frontend (`app/`)

- `app/src/lib/store.ts`:
  - Added `zwork-vision` to managed-router migration and token-sync.
  - Added `zwork-vision` to the synthetic web-mode providers list.
  - `needsManagedRouterMigration()` now checks for `zwork-vision` and re-migrates if missing/corrupted.
- `app/src/components/Onboarding.tsx`:
  - Added `zwork-vision` to the `zwork_managed` model catalog.
- `app/src/lib/api.ts`:
  - `streamChatWeb` now sends OpenAI Chat Completions format to `/api/v1/chat/completions` when `model === "zwork-vision"`.
  - Basic image attachment support in web mode (desktop is the primary path).

### Rust sidecar (`sidecar-rust/`)

- `src/server.rs`:
  - `ChatStreamRequest` now accepts `attachments: Vec<Attachment>`.
  - `Attachment` struct added.
  - `/api/uploads` response now includes `path`.
  - `zwork-vision` gets subtitle "Vision and images".
- `src/agent/mod.rs`:
  - `run_agent_turn` takes `attachments`.
  - Replaces the last user message content with full content blocks when attachments are present.
  - Fallback branch maps `model_id.contains("vision")` → `zwork-vision`.
- `src/agent/prompts.rs`:
  - `build_user_content(text, attachments)` creates Anthropic-style content blocks (text + base64 image blocks).
  - `convert_convo_for_openai()` translates Anthropic image blocks to OpenAI `image_url` blocks and fixes the user-content-array handling (was pushing one message per block).

### Cloud gateway (`cloud-src/`)

- `cloud-src/api/src/main.rs` already had the `gemma4:31b` model-ID fix from earlier in the session.
- `zwork-vision` resolves to `gemma4:31b` via `resolve_upstream_model()`.
- The `ai_proxy` OpenAI endpoint matches Ollama Cloud because its `primary_model` is `gemma4:31b`.

## Verified flow (desktop / Tauri)

1. User picks **zWork Vision** in the model picker.
2. Desktop app uploads image → `/api/uploads` returns absolute `path`.
3. App sends `POST /api/chat/stream` with `model: "zwork-vision"` and `attachments`.
4. Rust sidecar builds OpenAI Chat Completions request (shape "openai" for `zwork_router`) with `image_url` content parts.
5. Sidecar POSTs to `https://api.tryzwork.app/api/chat/completions`.
6. Gateway resolves model `zwork-vision` → `gemma4:31b`, picks Ollama Cloud provider (primary model match).
7. Gateway forwards OpenAI request to `https://ollama.com/v1/chat/completions`.
8. Ollama Cloud serves Gemma 4 31B with the image.

## Build status

- `sidecar-rust`: `cargo build` succeeds.
- `app`: `npm run build` succeeds.
- `cloud-src/api`: `cargo check` succeeds.

## Limitations

- Web mode image attachments reference local file paths (`image_url.url: a.path`), which the gateway cannot access. Full web-mode vision needs either base64-in-request or a public upload URL.
- Gateway `ai_proxy` currently buffers the whole upstream response before streaming it to the client; large images may be slow but should still work.
- zwork-vision is not gated behind a pro tier in code; it follows the same managed-router access as Flash/Pro.
