# Codebase Concerns

**Analysis Date:** 2026-05-25

## Tech Debt

**Zustand Store Monolith:**
- Issue: `useApp` store in `app/src/lib/store.ts` is 1,784 lines, mixing auth, chat, tasks, calendar, artifacts, settings, telemetry, and subagent state in one file.
- Files: `app/src/lib/store.ts`
- Impact: Hard to test, easy to introduce side effects, merge conflicts, and slow to navigate. Any change to one domain risks regressing another.
- Fix approach: Split into domain-specific stores (auth, chat, cockpit, artifacts) and compose them. Keep `useApp` as a thin facade only if needed for backward compatibility.

**Tauri Runtime Detection Duplication:**
- Issue: `typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__` is copy-pasted in 9 locations across the codebase.
- Files: `app/src/App.tsx`, `app/src/lib/api.ts`, `app/src/components/PlanPage.tsx`, `app/src/components/LoginScreen.tsx`, `app/src/components/ChatInput.tsx`, `app/src/components/OverlayChatView.tsx`
- Impact: Inconsistent environment detection, hard to maintain, and bypasses TypeScript safety with `as any`.
- Fix approach: Centralize in a single exported constant `IS_TAURI` in `app/src/lib/platform.ts` (or similar) and remove all `window as any` casts.

**Legacy Model Migration Code:**
- Issue: `needsManagedRouterMigration` and `migrateManagedRouterSettings` in `app/src/lib/store.ts` contain hardcoded legacy model IDs and base URLs.
- Files: `app/src/lib/store.ts` (lines 245-314)
- Impact: Dead code for old model configurations that may no longer exist in the wild. Adds noise and maintenance burden.
- Fix approach: Audit if any users still need this migration. If not, remove the functions and the `LEGACY_MANAGED_BASE_URLS` / `LEGACY_MANAGED_MODEL_IDS` constants.

**Hardcoded Cloud API Base URL:**
- Issue: `CLOUD_BASE = "https://api.tryzwork.app"` is hardcoded in `app/src/lib/cloud.ts`.
- Files: `app/src/lib/cloud.ts`
- Impact: Cannot point to staging or local backend without code changes.
- Fix approach: Read from an environment variable (e.g., `import.meta.env.VITE_CLOUD_BASE_URL`) with the production URL as fallback.

## Known Bugs

**Empty Catch Blocks Silently Swallowing Errors:**
- Symptoms: Some failures (localStorage parse, theme load, backend health) fail silently with no user feedback or telemetry.
- Files: `app/src/lib/theme.ts:28`, `app/src/lib/theme.ts:46`, `app/src/lib/store.ts:1030`, `app/src/lib/store.ts:1091`, `app/src/App.tsx:87`
- Trigger: Corrupted localStorage, network failure during onboarding status check, or backend unreachable.
- Workaround: None. Errors are invisible.

**Artifact Sheet Viewer Missing Dependency in useEffect:**
- Symptoms: Potential stale closure or missed updates when `artifact.id` or `updateArtifact` changes.
- Files: `app/src/components/artifacts/ArtifactSheetViewer.tsx:53`
- Trigger: Rapid artifact switches or prop changes.
- Workaround: None known. The `eslint-disable-line react-hooks/exhaustive-deps` suppresses the warning instead of fixing it.

**App.tsx useEffect Missing Dependency:**
- Symptoms: `isBrowserDevMode` effect may not re-run correctly if dependencies change.
- Files: `app/src/App.tsx:222`
- Trigger: Switching between dev and production builds at runtime (rare but possible in HMR).
- Workaround: None known. The `eslint-disable-next-line react-hooks/exhaustive-deps` suppresses the warning.

## Security Considerations

**LocalStorage Used for Sensitive Tokens:**
- Risk: Cloud auth token (`zwork:cloud-token`) and admin token (`zwork:admin-token`) are stored in `localStorage` / `sessionStorage`, vulnerable to XSS extraction.
- Files: `app/src/lib/cloud.ts`, `app/src/components/AdminPage.tsx`
- Current mitigation: None. Tokens are plaintext in storage.
- Recommendations: For Tauri desktop, use the Tauri secure storage plugin or OS keychain. For web, consider httpOnly cookies (requires backend change). At minimum, encrypt tokens before storing.

**iframe Sandbox in ArtifactPreviewViewer:**
- Risk: `ArtifactPreviewViewer` renders an iframe with `sandbox="allow-scripts allow-forms"` but no `allow-same-origin` restriction on the src.
- Files: `app/src/components/artifacts/ArtifactPreviewViewer.tsx:109`
- Current mitigation: sandbox attribute limits some capabilities.
- Recommendations: Ensure `src` is always same-origin or a trusted domain. Add Content-Security-Policy headers. Avoid `allow-scripts` if the preview content is user-generated and untrusted.

**API Keys in Client Memory:**
- Risk: User-provided API keys (Anthropic, OpenAI, etc.) are held in Zustand state and sent to the local backend. If the frontend is served over HTTP in dev mode, keys could be intercepted.
- Files: `app/src/components/Settings.tsx`
- Current mitigation: Keys are sent only to the local backend, not to cloud.
- Recommendations: Warn users when running in non-Tauri dev mode. Ensure the backend stores keys securely (keyring / OS credential store) rather than plaintext.

## Performance Bottlenecks

**Large Store Subscription Re-renders:**
- Problem: 193 usages of `useApp` selectors across the app. Many components select large objects (e.g., `s.chats`, `s.tasks`) causing unnecessary re-renders.
- Files: `app/src/lib/store.ts` (all consumers)
- Cause: Zustand selectors return new object references on every state change if not memoized.
- Improvement path: Use shallow equality (`useApp(selector, shallow)`) or split stores so components subscribe only to their domain.

**App.tsx useEffect Proliferation:**
- Problem: `App.tsx` contains 17 `useEffect` hooks handling auth, telemetry, updates, keyboard shortcuts, zoom, preview mode, and cloud sync.
- Files: `app/src/App.tsx`
- Cause: Single component doing too much orchestration.
- Improvement path: Extract domain-specific providers/hooks (e.g., `useKeyboardShortcuts`, `useAutoUpdater`, `useTelemetrySession`) to declutter App.tsx.

**Chat Message Re-renders During Streaming:**
- Problem: Every `delta` event triggers a `set` call that maps over all messages in the active chat.
- Files: `app/src/lib/store.ts` (lines 1363-1376)
- Cause: Immutable update pattern `messages.map(...)` creates a new array on every SSE chunk.
- Improvement path: For large chats, use a ref or local mutable buffer during streaming, then commit to Zustand only on `done` or at a throttled interval.

**URL.createObjectURL Without Revoke:**
- Problem: `URL.createObjectURL` is used in `ChatInput.tsx`, `ArtifactCodeViewer.tsx`, `ArtifactDocViewer.tsx`, and `LogoParticles.tsx` but not always paired with `URL.revokeObjectURL`.
- Files: `app/src/components/ChatInput.tsx:187`, `app/src/components/artifacts/ArtifactCodeViewer.tsx:198`, `app/src/components/artifacts/ArtifactDocViewer.tsx:281`, `app/src/components/artifacts/ArtifactDocViewer.tsx:293`, `app/src/components/LogoParticles.tsx:77`
- Cause: Blob URLs accumulate in memory until the document unloads.
- Improvement path: Revoke URLs in cleanup effects or after download completes.

## Fragile Areas

**Streaming Recovery Logic:**
- Files: `app/src/lib/api.ts` (lines 859-898)
- Why fragile: The `while (true)` retry loop in `streamChat` has multiple exit conditions (`sawTerminal`, `sawEvent`, `attemptedRecovery`, `AbortError`). Edge cases (e.g., backend crashes mid-stream) may leave the UI in a "working" state forever.
- Safe modification: Add a maximum retry count and ensure `onEvent({ type: "end" })` is always emitted, even on unexpected exits.
- Test coverage: No automated tests detected for SSE stream recovery.

**Composio Polling Without Cleanup:**
- Files: `app/src/lib/store.ts` (lines 974-988)
- Why fragile: `connectComposioApp` starts a `setInterval` that polls for 40 attempts (120 seconds total). If the component unmounts or the user navigates away, the interval keeps running.
- Safe modification: Store the interval ID in the store or a ref and expose a cleanup function. Clear it on `disconnectComposioApp` or app unmount.
- Test coverage: No tests for connector polling lifecycle.

**Artifact Content Serialization:**
- Files: `app/src/lib/store.ts` (lines 1744-1758)
- Why fragile: `updateArtifact` rebuilds `[[ARTIFACT ...]]` wire format with string concatenation and regex replacement. Special characters in titles or content could break parsing or produce invalid blocks.
- Safe modification: Use a proper template/string-builder function with escaping for title and language attributes. Add unit tests for edge cases (quotes, newlines, nested brackets).
- Test coverage: No tests for artifact serialization.

## Scaling Limits

**LocalStorage Offline Cache:**
- Current capacity: Entire chat history and summaries are JSON-stringified into `localStorage` on every state change.
- Limit: `localStorage` quota is typically 5-10 MB. Large chat histories with many artifacts will exceed this, causing `QuotaExceededError`.
- Scaling path: Migrate offline cache to IndexedDB (e.g., via `idb` or `dexie`). Compress JSON before storing. Implement cache eviction (LRU) for old chats.

**Zustand Store Size:**
- Current capacity: All chats, messages, artifacts, tasks, events, and settings live in a single in-memory object.
- Limit: As chat history grows, memory usage increases and initial hydration slows.
- Scaling path: Implement virtualized chat loading (fetch messages on demand, keep only recent in memory). Paginate task/event lists.

## Dependencies at Risk

**Tauri v2 API Stability:**
- Risk: The app uses `@tauri-apps/api/core`, `@tauri-apps/plugin-updater`, and `@tauri-apps/plugin-process`. Tauri v2 is still relatively new; breaking changes in patch releases could affect `invoke`, `getVersion`, or updater APIs.
- Impact: Desktop app build failures or runtime crashes on update.
- Migration plan: Pin Tauri dependency versions strictly. Monitor Tauri changelog before upgrading. Abstract Tauri calls behind a thin adapter (`app/src/lib/tauri.ts`) to localize breakage.

**PostHog Telemetry:**
- Risk: `@posthog/react` and `posthog-js` are loaded unconditionally in `main.tsx`. If PostHog CDN is blocked or slow, it delays app startup.
- Impact: Startup latency, especially in regions with poor connectivity to `us.i.posthog.com`.
- Migration plan: Lazy-load PostHog only when telemetry is enabled. Add a timeout to the PostHog init script.

## Missing Critical Features

**No Automated Tests:**
- Problem: Zero test files (`.test.ts`, `.spec.ts`, `.test.tsx`, `.spec.tsx`) found in the frontend codebase.
- Blocks: Cannot safely refactor the monolithic store, streaming logic, or artifact serialization without manual regression testing.
- Priority: High.

**No Error Boundary Beyond Root:**
- Problem: Only one `ErrorBoundary` component exists (`app/src/components/ErrorBoundary.tsx`), likely at the root. Individual features (chat, settings, artifacts) lack their own boundaries.
- Blocks: A crash in one feature (e.g., artifact viewer) takes down the entire app.
- Priority: Medium.

**No Request Retry/Backoff for Cloud API:**
- Problem: `cloudFetch` in `app/src/lib/cloud.ts` has a fixed 10-second timeout but no retry logic for transient failures.
- Blocks: Poor user experience on flaky networks. Analytics and billing calls may fail silently.
- Priority: Medium.

## Test Coverage Gaps

**Frontend (app/src):**
- What's not tested: All React components, Zustand store logic, API clients, streaming parsers, artifact serialization, and telemetry.
- Files: Entire `app/src/` directory.
- Risk: Any change to store shape, API response format, or component logic can break the app unnoticed.
- Priority: High.

**Streaming SSE Parser:**
- What's not tested: The SSE frame parser in `app/src/lib/api.ts` (lines 800-817) and the Anthropic SSE translator in `streamChatWeb` (lines 720-754).
- Files: `app/src/lib/api.ts`
- Risk: Malformed server responses or partial chunks can crash the parser or leak into the UI.
- Priority: High.

**Offline Fallback Logic:**
- What's not tested: The `backendOffline` flag path in `bootstrap`, `refreshChats`, and `openChat` that loads from `localStorage` cache.
- Files: `app/src/lib/store.ts` (lines 856-869, 917-931, 1016-1108)
- Risk: Corrupted cache data causes JSON parse errors that are silently swallowed, leading to empty chat states.
- Priority: Medium.

---

*Concerns audit: 2026-05-25*
