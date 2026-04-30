# Changelog

All notable changes to zWork are documented here.

## Unreleased

**Documentation and developer experience improvements.**

- Added product vision document (docs/VISION.md) articulating design principles
- Added technical roadmap (ROADMAP2.md) with quarterly implementation priorities
- Expanded CONTRIBUTING.md with comprehensive development setup and guidelines
- Added VSCode workspace configuration for consistent development experience
- Added CI workflow for automated frontend linting and backend testing
- Enhanced README with project badges for better visibility
- Improved release documentation with troubleshooting section
- Updated wiki index for better documentation discoverability

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
