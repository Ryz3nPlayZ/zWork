# Changelog

All notable changes to zWork are documented here.

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
