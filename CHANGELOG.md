# Changelog

All notable changes to zWork are documented in this file.

## v0.5.0-beta.5

**Fix: revert secret store to plaintext file I/O — eliminates keychain prompts.**

### Fixes
- **Removed the `keyring` crate entirely.** The secret store is back to pure plaintext file I/O (`~/.zwork/secrets.json`, 0o600) — exactly as it was in v0.5.0-alpha.19, before the regression was introduced. The backend no longer touches the macOS Keychain, Windows Credential Manager, or Linux Secret Service, so there are zero OS keychain authorization prompts on startup or anywhere else. This reverts the regression that was inadvertently bundled into the beta.2 release.

  Beta.3's in-process cache and beta.4's file-first-with-keychain-fallback were both over-engineered partial measures. The correct fix was to remove the keychain code altogether and return to what worked: a single plaintext file, no OS integration, no prompts.

  Secrets now live only in `~/.zwork/secrets.json`. If you previously stored keys in the keychain (via a beta.2/beta.3/beta.4 build), they are not migrated — re-enter your API key once in Settings after upgrading.

## v0.5.0-beta.4

**Fix: macOS keychain prompts — for real this time.**

### Fixes
- **Secret store now file-first (matching the Python backend).** The sidecar reads credentials from `~/.zwork/secrets.json` before ever touching the OS keychain, eliminating the keychain authorization prompts entirely on the read path. The keychain is now only a fallback for credentials missing from the file, and a best-effort sync target on writes. This restores the Python backend's `"file"` default mode (commit `16cc9a4`), which the Rust rewrite had inadvertently discarded in favor of keychain-first reads.

  The first launch after upgrading transparently migrates any existing keychain credentials into `secrets.json`, so file-first reads have data to find and never fall through to the keychain. After that one-time migration, the keychain is not consulted on reads at all — no prompts, ever.

  (Beta 3's in-process cache was a partial measure that only reduced prompt count; this is the actual fix. The cache has been removed since it's no longer needed.)

## v0.5.0-beta.3

**Fix: repeated macOS keychain prompts on startup.**

### Fixes
- **Keychain authorization prompts on startup** — the sidecar now caches resolved keychain values for the process lifetime, so the OS keychain is queried at most once per credential per process start. Previously, every `settings::load()` call re-read all 11 known credentials from the keychain, and the frontend bootstrap fired 3 concurrent endpoint calls — producing ~33 `"zwork-backend wants to use your confidential information stored in 'zwork'"` prompts on launch, with ~11 more on every chat turn and scheduler tick. Cache is kept coherent with `keyring_set` / `keyring_delete` so writes/deletes still take effect immediately.

## v0.5.0-beta.2

**UI polish, navigation fixes, and connector branding fixes.**

### Fixes
- **Back arrow on project chats** — the "back to project" arrow in the chat header now appears immediately when a chat is started from a project (previously it only showed after reloading the chat, because the project context wasn't carried onto the optimistically-created chat object).
- **Connector logos render correctly** — brand marks on the Connectors page were showing as solid colored squares because the CDN-hosted SVG `mask-image` was blocked by the Tauri CSP on macOS/Windows webviews. Logos are now inlined as SVG paths, eliminating the network fetch and CSP interaction entirely. Also refreshed the GitHub brand color to the current `#181717`.
- **`Cmd/Ctrl+S` toggles the sidebar** — new keyboard shortcut (alongside the existing `Cmd/Ctrl+\`) with `preventDefault` so the browser's "Save Page" dialog no longer fires. Documented in the keyboard shortcuts cheatsheet.

### Documentation
- New `docs/INTEGRATIONS.md` covering the Composio connector architecture, the full data flow, and a step-by-step checklist for enabling new toolkits (e.g. Linear). Documents that the "linear is not yet configured" error is a Composio dashboard auth-config task, not a code gap — the integration plumbing is complete and identical to the working apps.

## v0.5.0-beta.1

**Scheduled agents, app integrations, and a Rust-native backend rewrite.**

This release turns zWork from a chat assistant into a persistent agent: it can run jobs on a schedule, reach into your real apps, and control the desktop — all on a rewritten Rust backend.

### Backend rewrite
- **Local engine is now Rust (Axum).** The Python/FastAPI sidecar has been replaced by a native Rust sidecar (`sidecar-rust/`) — faster startup, lower memory, no Python runtime to ship. Same HTTP surface and chat UX.
- Structured agent logging preserved: run-scoped lifecycle events alongside per-turn `request`/`tool_call`/`finish` trace in `agent.jsonl`.

### New capabilities
- **Scheduled agents** — define recurring tasks (every N minutes, or daily at HH:MM on selected weekdays); a background scheduler fires them on their own and posts results to the inbox. Includes a "Run now" button and free-tier task cap.
- **Inbox** — a dedicated surface for scheduled-task output (summaries, flags, errors), with read/unread and delete.
- **Composio integrations** — connect Gmail, Calendar, Slack, and hundreds more; their actions are exposed to the agent as `composio__*` tools. The platform API key is proxied through zWork Cloud and never touches the client.
- **MCP runtime** — any stdio MCP server from `~/.zwork/mcp.json` (Claude-Desktop shape) is loaded and exposed as `mcp__<server>__<tool>` tools.
- **`desktop_office` tool** — semantic `.docx`/`.xlsx` editing without a GUI.
- **`deploy_web_app` tool** — serves a local web app (npm dev or static) and returns a live URL.

### Desktop & browser control (carried forward from alpha.13)
- cua-driver for native macOS automation (capture AX tree, click, type, scroll, keys).
- Embedded Chrome bridge for element-level browser automation.

### Docs
- README and architecture docs updated to reflect the Rust backend and the new feature surface.
- Roadmap refreshed to v0.5.x.

## v0.5.0-alpha.19

**Critical fix: the app no longer silently terminates on every message.**

- Fixes a regression introduced in v0.5.0-alpha.18 where every message terminated instantly — no response, no error, no loading state. The agent harness had been switched to a `goose` subprocess that exited with code 1 on launch for all models (zWork Pro / Flash / Vision).
- Restored the proven native `stream_llm` agent loop (unified `LlmEvent` layer, per-protocol Anthropic/OpenAI parsers, loud tool-JSON failure). DeepSeek v4 Pro responds and streams again.
- Removed the goose subprocess scaffolding (stdio MCP bridge and `mcp` subcommand). Live tool activity, permission gating for destructive tools, and single-source chat history are restored.
- Preserved structured agent logging: run-scoped `turn_start` / `provider_resolved` lifecycle events alongside the per-turn `request` / `tool_call` / `finish` trace in `agent.jsonl`.
- Updated version to 0.5.0-alpha.19.

> ⚠️ If you installed v0.5.0-alpha.18, update to this build — alpha.18 cannot respond to any message.

## v0.5.0-alpha.13

**Desktop control via cua-driver, embedded browser bridge, redesigned overlay.**

- Integrated cua-driver for background macOS desktop control: capture AX tree, click by element index, type, scroll, keyboard shortcuts
- Replaced dctl CLI wrapper with 17 structured tool schemas: `desktop_capture`, `desktop_click`, `desktop_type`, `desktop_scroll`, `desktop_key`, `desktop_focus`, `desktop_list_apps`, `desktop_wait`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_eval`, `browser_scroll`, `browser_screenshot`, `browser_tabs`
- Embedded zbctl WebSocket bridge directly into zWork Rust backend — no Python daemon required. Chrome extension connects to ws://127.0.0.1:8787/ws
- Bundled cua-driver as Tauri sidecar binary, extension as app resource
- Redesigned global overlay (Cmd+Ctrl+Space) with clean command bar, scale+fade animation, theme-aware design tokens
- Updated system prompt with capture→act workflow guidance, desktop vs browser tool selection
- Removed dctl dependency from CI pipeline
- Updated version to 0.5.0-alpha.13

## v0.4.0-beta.2

**Migrated to pruned Hermes backend agent engine, added Ollama Cloud vision routing, and enhanced test resilience.**

- Migrated sidecar backend execution loop to a clean, de-branded version of the Hermes Agent engine.
- Integrated server-side routing for vision-capable models (e.g. `gemma4:31b-cloud`, `llama-3.2-90b-vision`) to run across multiple Ollama cloud providers.
- Connected Groq provider for specialized text model routing (`meta-llama/llama-4-scout-17b-16e-instruct`).
- Made local unit test suites resilient to external Yahoo Finance rate-limiting or network connection drops by skipping test runs gracefully on 429 errors.
- Cleaned up frontend references, verified version alignment across all configs, and updated Tauri packages.

## v0.4.0-beta.1

**Rich document editor, spreadsheet suite, interactive sandbox, and code execution previews.**

- Added full WYSIWYG document editor with formatting tools and export actions.
- Integrated advanced spreadsheet component with formulas and CSV import/export.
- Implemented interactive HTML/SVG code execution sandbox previews directly inside the Artifact view.
- Added dark stock candlestick chart playground and Yahoo Finance `get_stock_data` agent tool.
- Fixed memory leaks in chat viewport exports, centralized Tauri platform checks, and set up beta release channel pipelines.

## v0.4.0-alpha.19

**Project chat embedding, UI cleanup, and connector logo fixes.**

- Fixed project chats to render inline within the project page instead of navigating to the normal chat view
- Added `ProjectChatThread` component with full message rendering, activities, error banners, and retry/settings buttons
- Removed per-project Memory card — global memory in Settings is now the single source of truth
- Removed per-project Timeline card to reduce clutter
- Replaced generic browser `confirm()` with a custom styled delete confirmation modal for project files
- Fixed connector brand logos to use Simple Icons CDN via jsDelivr for accurate, up-to-date brand marks
- Added admin dashboard cost tracking (prompt/completion tokens and estimated API cost per user)
- Added web mode Pro model support (`zwork-pro` → `deepseek-v4-pro` routing)

## v0.4.0-alpha.18

**Auto-diagnosing command runner, hardware detection, and academic research paper writing tools.**

- Added command failure auto-diagnostics (`_diagnose_command_failure`) inside the `run_command` tool to detect and recommend fixes for missing packages, binary path failures, blocked ports, permission issues, and out-of-memory errors.
- Added `detect_hardware` tool to query GPU (NVIDIA CUDA, Apple MPS) and CPU thread count.
- Added `check_novelty` tool to compute Jaccard keyword overlap similarity against literature databases for a research hypothesis.
- Added `review_paper` tool to analyze structure, count placeholders, and score paper quality.
- Added `write_research_paper` tool to autonomously execute literature search, build verified bibliographies, and compile structured Markdown/LaTeX paper drafts.
- Fixed unit test suites (`test_chatstore`, `test_compaction`, `test_projects`, `test_secretstore`, `test_skills`, `test_taskstore`) to align with actual Python module API signatures.

## v0.4.0-alpha.9

**Fix auto-updater relaunch WebKit crash on Linux.**

- Unset `WEBKIT_EXEC_PATH` environment variable when using system WebKitGTK to prevent relaunch process spawn crashes on Linux.

## v0.4.0-alpha.8

**Task & Calendar Cockpit, Fine-Grained dctl Tools, and Production Readiness.**

- Added toggleable Task & Calendar Cockpit drawer (Kanban board & daily agenda) via Cmd+J/Ctrl+J.
- Upgraded desktop control with fine-grained dctl tools (dctl_system, dctl_ui, dctl_browser, dctl_office).
- Injected dctl instruction addon into agent system prompts for precise automation.
- Handled Better Auth OAuth route resolution to prevent state mismatches.

## v0.4.0-alpha.4

**UI redesign: Connectors, Analytics, and Plan pages.**

- redesigned Connectors page with actual brand logos (Gmail, Slack, Notion, GitHub, Linear, etc.) instead of generic Lucide icons
- redesigned Analytics page with improved visual hierarchy, stat cards, and empty states
- redesigned Plan page with clearer pricing card layout and stronger typography hierarchy
- softened color palette across light and dark modes: less extreme whites and blacks, warmer neutrals
- fixed dark-mode accessibility issue where `bg-ink text-white` buttons became invisible
- added `design.md` as locked design system for app pages

## v0.4.0-alpha.2

**Hotfix: backend crash loop on fresh install / OAuth redirect.**

- fixed backend process manager killing healthy backends via `fuser -k` on every respawn — now only cleans stale processes at app startup
- added lock-guarded re-check of backend health after acquiring mutex to prevent concurrent threads from killing a freshly spawned backend
- added 5-second grace period for newly spawned backends so Uvicorn has time to bind before health checks trigger a kill

## v0.4.0-alpha.1

**Critical regression fixes: backend stability, keychain, onboarding, plan UX.**

- hardened backend watchdog: increased health-check timeout 600ms→5s, interval 10s→30s, added retry before killing to prevent mid-stream backend death
- changed default secret store to file-based storage to avoid macOS Keychain permission prompts; file store is tried first in all modes
- fixed Add Model flow silently failing: API errors are now surfaced in the form UI; reduced backend preflight attempts 20→6
- removed Pro tier gate on zWork Router during onboarding so all signed-in users can select the managed router
- wired Plan page into app routing with Stripe checkout, billing portal, and coupon code redemption UI
- added Plan navigation link to sidebar

**Advanced agent loop: subagent spawning and tool streaming.**

- added `spawn_agent` tool for explicit parallel task delegation
- added subagent spawning system with `SubagentSpawner` for concurrent agent execution
- added `ConcurrentWorkBanner` UI component showing active subagent progress
- added `tool_progress` SSE event type for streaming tool progress updates
- added `MilestoneTracker` in streaming.py for meaningful progress updates
- added subagent state tracking to frontend store with `SubagentTask` interface
- added subagent SSE events: `subagent_started`, `subagent_progress`, `subagent_delta`, `subagent_activity`, `subagent_done`

**Harness feature integration: plan mode, compaction, and project context.**

- integrated conversation compaction into chat stream (summarizes middle when >120k chars)
- added project context injection to system prompt when project_id is set
- added plan mode toggle to chat composer for read-only exploration
- added auto-approve destructive toggle to control permission gate
- added permission and compaction SSE events for UI feedback
- fixed circular import between providers.py and compaction.py

## Unreleased

## v0.3.18-beta.8

**Backend supervision and DeepSeek router hardening.**

- changed the desktop backend manager to verify local backend health instead of trusting stale child-process handles
- added a lightweight backend watchdog and broader local API readiness checks so the app can recover when the sidecar exits
- preserved onboarding completion locally and stopped Settings from re-triggering onboarding during backend outages
- stopped transient cloud session failures from clearing the desktop token
- resynced the managed zWork Router token from the active desktop session
- preserved DeepSeek thinking/reasoning payloads through Anthropic and OpenAI-compatible tool loops
- kept the hosted router on DeepSeek's Anthropic-compatible endpoint and documented the required server protocol flag

## v0.3.18-beta.7

**Hotfix for local backend streaming and real usage surfaces.**

- fixed `/api/chat/stream` returning 500 before the first SSE event by creating run IDs with the required prefix
- fixed run logging/context cleanup errors that could turn provider failures into backend failures
- added desktop chat preflight/recovery so Tauri restarts the local backend once before surfacing a connection failure
- replaced hardcoded Analytics data with live `/api/analytics/summary` usage, quota, active-run, and owner provider health data
- simplified the Settings Plan panel to show account tier, router readiness, and quota without redundant cards
- hardened PyInstaller backend packaging for keyring, sidecar, and MCP runtime imports without pulling in optional MCP CLI dependencies

## v0.3.18-beta.6

**Harness hardening, DeepSeek router release, and updater readiness.**

- moved provider API keys out of `settings.json` into a keyring-backed secret store
- kept a file fallback for environments without a usable OS keychain backend
- added migration logic so legacy plaintext keys are rewritten out of the settings file
- added regression coverage for secret storage and provider enumeration
- pinned the managed zWork Router path to DeepSeek V4 Flash
- added MCP client support with stdio server startup, tool registration, status APIs, and tests
- added project context injection, plan-mode read-only tool filtering, destructive command gating, and chat compaction
- added `web_search` for current news/research requests so the agent can answer in chat without opening browser tabs
- blocked commands that target and kill the local backend on port `8787`
- hardened desktop backend readiness by adding Tauri ensure/restart commands and longer onboarding health checks
- added release checklist coverage for rar-files PR intent and updater smoke tests
- consolidated root-level planning docs under `docs/` and `docs/archive/`
- bumped release metadata for the next signed desktop build

## v0.3.18-beta.5

**Release fallback so users can still install the latest build when the native updater is flaky.**

- added a GitHub Releases fallback in update detection so the app can still surface the newest installer
- kept the native Tauri updater path first, so normal updater installs still work when the pipeline is healthy
- wired the release workflow to publish the new beta tag and fresh installer assets

## v0.3.18-beta.4

**Design system polish and accessibility improvements.**

- added keyboard focus indicators (ring-focus) to all interactive elements
- replaced hard-coded error colors with design tokens (border-line-strong, bg-paper-sunken)
- removed console.error statements from production code
- unified hover and press states using the `.press` class across components
- simplified visual treatments (removed gradient backgrounds for cleaner aesthetic)
- improved Analytics page layout with balanced 2-column grid
- cleaned up unused imports and code
- added hover states to feature cards
- consistent error messaging across all UI surfaces

## v0.3.18-beta.3

**UI/UX refactoring for non-technical users.**

- completely redesigned LoginScreen with animated background, rotating headline, and clear feature cards
- refactored Settings Plan panel with user-friendly language, visual progress bars, and quick actions
- redesigned Analytics page to remove developer jargon and focus on user-facing metrics
- added color-coded quota indicators (green/amber/red) for at-a-glance usage status
- simplified "how limits work" explanation for regular users
- improved visual hierarchy across all auth and settings screens
- temporarily disabled non-gpt-oss-120B models on hosted server (20b, llama, mistral)

## v0.3.18-beta.2

**Router pivot, quota visibility, and updater hardening.**

- replaced the old managed Ollama path with `zWork Router` backed by Groq, Cerebras, and Mistral with ordered fallbacks
- added automatic migration for older beta installs that still pointed hosted mode at the dead Ollama cloud endpoint
- surfaced the exact routed model under assistant messages so hosted responses show the real upstream model used
- redesigned Analytics around rolling `5 hour` and `weekly` quota bars plus 7d/1m usage trends
- added a real Plan panel in Settings with hosted route status and quota runway
- normalized hosted upstream JSON responses into SSE on the server so the desktop sidecar can stream managed responses correctly
- added owner-only provider overview data in analytics, including 7-day request and token totals plus latest observed rate-limit headroom when the provider exposes it
- removed the fake GitHub fallback from update detection so the app only advertises native updates when an installable updater package actually exists

## v0.3.18-beta.1

**Beta release for real sign-in, analytics, access codes, and hosted-mode wiring.**

- added PostHog to the desktop frontend and identify/reset around cloud sign-in so auth, onboarding, update, and access-code events land in one project
- surfaced `zWork Managed` as a first-class onboarding option for signed-in users instead of burying the hosted route only in Analytics
- renamed the dev unlock flow from "coupon" to "access code" in the desktop UX and improved server error messaging for bad or missing codes
- added hosted-gateway readiness status to Analytics so the app can clearly show when the server still needs an upstream model key
- kept the managed desktop route session-backed and local-agentic: the sidecar stays on-device while model traffic can be repointed to the hosted gateway
- preserved the updater/version fixes from the alpha line so beta builds still report the bundled version and stay compatible with future update ordering

## v0.4.0 — Cloud Auth & User Tracking

**Authentication, cloud proxy, and user management.**

- Added Google OAuth 2.0 login flow with desktop popup window
- Added initial login screen (`LoginScreen`) shown before main UI when unauthenticated
- Added account section in Settings with user profile and sign-out
- Added user session persistence via localStorage
- Restored Better Auth (v1.6.9) cloud service with PostgreSQL kysely adapter
- Added PostgreSQL `users` table for tracking Google OAuth users, subscription tiers, and billing status
- Added Axum API endpoints: `GET /api/users/:google_id`, `POST /api/users`, `PUT /api/users/:google_id/tier`
- Added `oauth-callback.html` for handling desktop OAuth redirects
- Fixed Caddy routing for auth endpoints at `api.tryzwork.app/api/auth/*`

## v0.3.18-alpha.1

**Alpha release focused on auth, managed routing, analytics, and updater stability.**

- added a required desktop account gate with Google sign-in through the live server
- added desktop auth code exchange, bearer-backed managed sessions, coupon redemption, and analytics endpoints on the cloud API
- added an Analytics tab with usage stats, managed-mode controls, coupon testing, and infra links
- wired the desktop app to switch the local harness onto the managed hosted gateway while preserving local agent execution
- fixed runtime version reporting so the app shows the bundled Tauri version instead of stale package metadata
- tightened updater failure handling so native updater errors stay in-app instead of immediately punting users to GitHub
- fixed version comparison for prerelease tags so alpha builds do not break future stable update ordering
- removed invalid Tauri bundle config that was blocking desktop Rust builds altogether

## v0.3.11

- Restored macOS drag regions while removing the duplicate drag strip from Windows layouts.
- Replaced the homepage glow with the same ray background direction as onboarding, coming up from the bottom.
- Cleaned artifact rendering so the model no longer emits the stray `Text` / `Open` / `undefined` code block before artifact cards.
- Removed the hidden tooltip from the collapsed sidebar expand button.

## v0.3.10

**Make telemetry default-on and fix update handoff.**

- Enabled anonymous telemetry by default for new installs while keeping the opt-out toggle in Settings
- Removed the onboarding telemetry opt-in step so users do not have to answer it during setup
- Fixed the update card fallback so clicking it opens the release page reliably when native install is unavailable
- Added a visible opening state so the updater does not appear to do nothing after a click

## v0.3.9

**Remove broken landing particles and add anonymous analytics opt-in.**

- Removed the broken landing particle renderer and the duplicate top drag strip
- Added an explicit anonymous analytics opt-in with a clear privacy disclosure
- Added anonymous telemetry for app open/close, active session time, onboarding completion, chat turn counts, settings changes, and update success/failure
- Kept message content, files, API keys, screenshots, and paths out of telemetry

## v0.3.8

**Fix Windows backend startup encoding.**

- Forced the backend process to use UTF-8 I/O on Windows so startup logs cannot crash the packaged Python server
- Changed the startup banner to ASCII-safe text so the backend can launch cleanly under cp1252 consoles
- Applied the UTF-8 environment settings to both packaged and dev backend launchers

## v0.3.7

**Tighten updater UX and fix app shell shortcuts.**

- Added visible version info in Settings
- Simplified the update card copy and layout to a compact current-version -> latest-version prompt
- Added real in-app updater progress states so Update now no longer appears to flash and reset
- Added a post-update changelog notice after relaunch
- Fixed the duplicate `Cmd+K` handler that could immediately close search
- Added a dedicated top drag strip so the window is easier to move

## v0.3.6

**Remove chat-load flashes and harden long-running streams.**

- Removed the centered loading-card transition when sending the first message from the landing screen
- Slowed the rotating in-thread working copy to a 5-second cadence instead of rapid cycling
- Added SSE heartbeat events and stricter stream finalization so long skill/tool turns do not silently die in the UI
- Tightened the landing logo-particle field into a denser square composition instead of stretching it across one axis

## v0.3.5

**Fix landing particle renderer boot.**

- Fixed the landing particle canvas initializing at `0px` height in fill mode, which could make the home screen look blank
- Kept the particle renderer code-split so the landing fix does not bloat the main app bundle
- Preserved lower-motion behavior without falling back to a fully static logo

## v0.3.4

**Harden desktop state isolation and chat streaming.**

- Isolated packaged desktop state from `~/.zwork` so installed builds no longer inherit local dev/session data
- Turned dropped local chat streams into in-app backend errors instead of surfacing raw `TypeError: Load failed`
- Kept onboarding on `LightRays` while restoring the logo particle backdrop on the empty home screen

## v0.3.3

**Patch macOS backend resource path and onboarding visual.**

- Swapped onboarding to the React Bits LightRays visual backed by `ogl`
- Fixed the macOS universal backend launcher for Tauri's nested resource path
- Kept the onboarding headline centered in the left visual area

## v0.3.2

**Patch universal macOS backend launch and restore optimized onboarding dither.**

- Replaced the lipo-merged macOS backend with an architecture-selecting launcher
- Shipped both Intel and Apple Silicon backend binaries inside the universal app
- Restored the onboarding dither as a low-resolution canvas renderer instead of WebGL
- Centered the “Your agent for…” visual within the left onboarding area
- Added backend readiness retry and clearer onboarding setup errors

## v0.3.1

**Patch onboarding performance and first-run model setup.**

- Replaced the onboarding WebGL dither background with a lightweight CSS backdrop
- Restricted the pre-v1 Ollama path to MiniMax M2.7 Cloud
- Repaired stale/default model selection after onboarding and provider refreshes
- Persisted onboarding completion before personalization generation can fail or stall
- Improved onboarding headline spacing and card readability

## v0.3.0

**Pre-v1 desktop release for macOS, Windows, and Linux.**

- Added a macOS universal release path for one DMG across Intel and Apple Silicon
- Hardened GitHub Actions release artifacts and updater manifest generation
- Simplified install scripts for non-technical users
- Reduced landing screen animation cost to keep first-run and chat entry responsive

## v0.2.2

**Fix Linux AppImage startup crash on WebKitGTK.**

- Added Linux WebKitGTK fallback environment flags at startup
- Fixed packaged backend imports so the release binary starts cleanly under PyInstaller
- Kept the updater/release flow aligned with signed GitHub Releases

## v0.2.0

**Cross-platform support — now available on Windows.**

- Added Windows distribution (NSIS installer) alongside Linux and macOS
- Added GitHub Actions CI to build all platforms automatically on release
- Fixed cross-platform issues in the desktop shell (paths, environment variables)
- Improved update card on the landing page with clearer download button
- Artifact mode now defaults to off for cleaner chat experience
- Added browser tooling guidance to agent instructions
- Updated README and docs for non-technical users

## v0.1.0

**Initial release.**

- Chat-first desktop AI assistant
- Local file and command workflows
- Reusable skills library
- Streaming output with activity updates
- Settings for models, credentials, and personalization
- Linux AppImage packaging with one-command install
