# Desktop Code Map

This is the quickest way to understand the shipped desktop app without reading the entire tree.

## Top-level structure

| Path | Responsibility |
|------|----------------|
| `app/src/App.tsx` | app shell, auth gate, view routing, updater card, analytics screen selection |
| `app/src/components` | user-facing screens and UI building blocks |
| `app/src/lib` | API clients, store, updater, telemetry, helpers |
| `app/src-tauri/src/main.rs` | native shell, sidecar process management, external browser auth callback |

## Main screens

| File | Role |
|------|------|
| `components/CloudGate.tsx` | mandatory sign-in gate before app usage |
| `components/Landing.tsx` | empty-state / first-action landing surface |
| `components/ChatView.tsx` | main conversation pane |
| `components/Settings.tsx` | account, model, general settings |
| `components/AnalyticsPage.tsx` | hosted usage, coupon redemption, managed mode activation |
| `components/Onboarding.tsx` | first-run onboarding flow |
| `components/Sidebar.tsx` | navigation, chat history, analytics entry point |

## Core state and clients

## `app/src/lib/store.ts`

This is the main Zustand store. It owns:

- current view
- auth/user state
- provider/settings refresh
- chat list and active chat
- model selection
- onboarding state
- artifact panel state

If you want to understand how a UI action mutates application state, start here.

## `app/src/lib/cloud.ts`

Cloud-specific desktop client:

- starts the browser-based sign-in flow
- exchanges desktop auth code for a bearer token
- fetches the signed-in cloud session
- redeems dev coupons
- fetches analytics summary

## `app/src/lib/update.ts`

Updater logic:

- checks native Tauri updater first
- falls back to GitHub latest release metadata only for detection
- installs updates through native `downloadAndInstall()`
- preserves a post-install notice across relaunch

## `app/src/lib/appVersion.ts`

Runtime version helper that prefers the bundled Tauri version over stale package metadata.

This matters because version drift was the reason older builds appeared to install “latest” while still reporting older versions.

## Native shell

`app/src-tauri/src/main.rs` owns:

- external URL opening
- browser-based desktop auth callback listener on localhost
- packaged sidecar process startup
- Tauri plugin wiring

When desktop auth or packaged backend startup breaks, inspect this file first.

## Typical debugging paths

## “Sign-in doesn’t work”

Look at:

- `components/CloudGate.tsx`
- `lib/cloud.ts`
- `src-tauri/src/main.rs`

## “Managed mode doesn’t route correctly”

Look at:

- `components/AnalyticsPage.tsx`
- `lib/store.ts`
- `lib/api.ts`

## “Updater detects the wrong version”

Look at:

- `lib/appVersion.ts`
- `lib/update.ts`
- `src-tauri/tauri.conf.json`

## “Sidebar/settings state feels wrong”

Look at:

- `components/Sidebar.tsx`
- `components/Settings.tsx`
- `lib/store.ts`
