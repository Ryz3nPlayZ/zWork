# Changelog

All notable changes to zWork are documented here.

## Unreleased

**Harness feature integration: plan mode, compaction, and project context.**

- integrated conversation compaction into chat stream (summarizes middle when >120k chars)
- added project context injection to system prompt when project_id is set
- added plan mode toggle to chat composer for read-only exploration
- added auto-approve destructive toggle to control permission gate
- added permission and compaction SSE events for UI feedback
- fixed circular import between providers.py and compaction.py

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
