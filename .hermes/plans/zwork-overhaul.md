# zWork Comprehensive Overhaul Plan

> **Generated:** 2026-07-04. This plan is analysis-driven — no code changes until all research results are consumed and each phase has explicit verification steps.

**Goal:** Transform zWork from a crash-prone, inconsistent, half-wired prototype into a stable, polished desktop AI assistant by systematically fixing every layer: backend stability → agent loop robustness → UI/UX consistency → dead-code purge.

**Architecture:** Tauri 2 (Rust shell) + React 18 frontend + Rust sidecar (Axum + Tokio, port 8787). The sidecar handles agent loop, tool dispatch, LLM streaming, chat persistence, and MCP/cua-driver integration.

---

## Current State Assessment (Phase 0 — Audit Complete)

### What's broken or known-bad

| # | Issue | Root Cause | Severity |
|---|-------|------------|----------|
| 1 | **Backend crash-loop** | Stale packaged binary (Jul 4, pre-overhaul). Fixed: rebuilt release, deployed fresh binary. `cargo test` = 44/44 pass. Health check returns `{"ok":true}`. | ✅ Fixed |
| 2 | **Window not draggable** | `.titlebar-drag` CSS class deleted by user; `App.tsx:495` still references dead class. **UNVERIFIED FIX:** restored as `data-tauri-drag-region`. Needs Tauri dev test. | ⚠️ Needs verification |
| 3 | **Sidebar translucency shows nothing** | `Effect.Sidebar` applies to whole window, but Sidebar `<aside>` has opaque `bg-paper-sidebar` class. Native vibrancy can't show through opaque DOM. | ❌ Not fixed |
| 4 | **`decorations: true` + `titleBarStyle: Overlay`** | Tauri 2 docs: drag-region attribute works reliably with `decorations: false`. Current config has both `decorations: true` AND `titleBarStyle: Overlay` — may conflict. | ⚠️ Needs verification |
| 5 | **Agent loop failures** | 544KB agent.jsonl unread. Chat files show empty assistant messages, `needs_setup` flags. Doom-loop recovery text added but underlying causes unaddressed. | ❌ Not investigated |
| 6 | **`ask_user` flow is split-brained** | `tools/mod.rs` has native `ask_question` tool (oneshot channel, `/answer-question` endpoint). `AskCard.tsx` parses `<<ASK>>...<<</ASK>>` from message text. `ChatView.tsx` renders `pendingQuestion` inline, not as a popup card. Two competing mechanisms. | ❌ Not unified |
| 7 | **Dead UX elements** | Tasks page deferred (`setView("tasks")` commented out). DailyGoalBar hidden. Inbox/Scheduled/Projects pages have inconsistent headers and spacing. | ❌ Not audited |
| 8 | **76 `.unwrap()` calls in Rust** | Many in non-test paths (`academic.rs`, `compaction.rs`, `prompts.rs`, `mcp.rs`). Potential panic vectors. | ⚠️ Tech debt |
| 9 | **Composio result shaping** | User's WIP: `shape_email_list`, `shape_single_message`, `extract_cloud_envelope`, `cap_result`. Committed + tested. | ✅ Done |
| 10 | **Separator lines look ugly** | Inconsistent `border-b border-line`, `h-px bg-line`, `divide-y` usage across components. No spacing-based separation. | ❌ Not addressed |

### What's working

- Rust sidecar compiles clean (`cargo check` + `cargo test` = 44/44)
- TypeScript compiles clean (`tsc --noEmit` = exit 0)
- Agent loop has doom-loop detection, compaction, orientation blocks, prompt caching
- `ask_question` tool infrastructure exists (oneshot channel + endpoint)
- `ask_user_for_permission` tool exists (same pattern)
- Chat persistence works (chatstore.rs)
- cua-driver MCP client works (standard MCP protocol)
- Browser bridge works (embedded WebSocket)
- System prompt has live environment status injection

---

## Phase 1: Verify & Fix Window Shell (Drag + Translucency)

**Depends on:** Tauri 2 docs research, translucency layer-chain trace

### Task 1.1: Verify Tauri window config for drag region

**Files:**
- Read: `app/src-tauri/tauri.conf.json` (window config)
- Read: Tauri 2 docs on `data-tauri-drag-region` + `titleBarStyle` + `decorations`

**Steps:**
1. Check Tauri 2 docs: does `data-tauri-drag-region` work with `decorations: true` + `titleBarStyle: Overlay`?
2. If not: change `decorations: true` → `decorations: false` in tauri.conf.json
3. Run `npm run tauri dev` and test dragging the top 38px strip
4. If drag doesn't work: investigate `startDragging()` JS approach as fallback

**Verification:** Window drags by clicking+dragging the top 38px strip. Traffic lights remain clickable.

### Task 1.2: Fix sidebar translucency layer chain

**Files:**
- Modify: `app/src/components/Sidebar.tsx` (aside background classes)
- Modify: `app/src/index.css` (sidebar-translucent CSS rules)
- Read: `app/src/lib/translucency.ts` (Effect.Sidebar application)

**Root cause:** `Effect.Sidebar` tints the entire NSWindow. For the wallpaper to show through, every DOM element from `<html>` → `<body>` → `<div class="flex h-screen">` → `<aside>` must be transparent in the sidebar region. Currently:
- `<html>.sidebar-translucent body` → `background: transparent` ✅
- `<div class="flex h-screen ... bg-transparent">` → transparent when `useNativeGlass` ✅
- `<aside class="... bg-transparent">` → transparent when `useNativeGlass` ✅ (Sidebar.tsx:90)
- BUT: internal sidebar elements may still have opaque backgrounds

**Steps:**
1. Trace every child element inside `<aside>` for opaque `bg-*` classes
2. When `useNativeGlass` is true, ALL sidebar children must be transparent or semi-transparent
3. Add a CSS rule: `html.sidebar-translucent .sidebar-surface { background: transparent !important; }` or use a conditional class approach
4. Test with translucency toggle ON in Settings

**Verification:** With translucency ON on macOS, the sidebar shows the desktop wallpaper through frosted glass. With translucency OFF, sidebar shows opaque `bg-paper-sidebar`.

### Task 1.3: Remove competing drag mechanisms

**Files:**
- Modify: `app/src/components/Sidebar.tsx` (remove `onDragMouseDown` handler if CSS approach works)

**Steps:**
1. If Task 1.1 verifies that `data-tauri-drag-region` works: remove the `onDragMouseDown` JS handler from Sidebar.tsx
2. If CSS approach doesn't work: keep JS handler, add it to the main content area top strip too

**Verification:** Only one drag mechanism is active. No conflict between CSS drag-region and JS startDragging().

---

## Phase 2: Agent Loop Hardening

**Depends on:** Goose + OpenCode research results

### Task 2.1: Audit agent.jsonl for failure patterns

**Files:**
- Read: `~/Library/Application Support/zWork/state/logs/agent.jsonl` (tail 500 lines)
- Read: 5 most recent chat JSON files

**Steps:**
1. Extract all error events from agent.jsonl
2. Categorize: provider errors, tool failures, doom loops, timeouts, empty responses
3. Identify the top 3 failure modes
4. For each: trace the root cause in `agent/mod.rs`

### Task 2.2: Harden tool-call error recovery

**Files:**
- Modify: `sidecar-rust/src/agent/mod.rs` (error handling in main loop)
- Modify: `sidecar-rust/src/agent/llm/mod.rs` (stream error handling)

**Steps (based on Goose/OpenCode patterns — to be refined after research):**
1. Add retry logic for transient provider errors (429, 500, 503) with exponential backoff
2. On tool execution error: feed the error back to the model with guidance (not just break)
3. On malformed tool call: emit a corrective tool_result instead of breaking the turn
4. Add a "turn budget" warning at 70% of max_turns (emit status to UI)

### Task 2.3: Improve system prompt delivery

**Files:**
- Read: `sidecar-rust/src/settings.rs` (SYSTEM_PROMPT_TEMPLATE)
- Read: `sidecar-rust/src/agent/mod.rs` (prompt assembly, lines 400-470)

**Steps:**
1. Audit system prompt for contradictions, missing instructions, stale references
2. Ensure tool descriptions match actual tool schemas
3. Add clear instructions for when to use `ask_question` vs `ask_user_for_permission`
4. Verify live environment status injection works for all tool categories

---

## Phase 3: Unify ask_user Flow

**Depends on:** Hermes + Vellum research results

### Task 3.1: Design unified ask_user protocol

**Files:**
- Read: `app/src/components/AskCard.tsx` (<<ASK>> parser)
- Read: `app/src/components/ChatView.tsx:279-304` (pendingQuestion rendering)
- Read: `sidecar-rust/src/tools/mod.rs:891-956` (ask_question tool)
- Read: `sidecar-rust/src/agent/mod.rs:134-163` (pending_questions infrastructure)

**Current state (two competing mechanisms):**

**Mechanism A (native tool — correct):**
- Model calls `ask_question(question, options)` tool
- Tool registers a oneshot channel, emits `ask_question` SSE event
- Frontend receives event, stores in `chat.pendingQuestion`
- User clicks an option → `POST /api/chats/:id/answer-question`
- Backend resolves oneshot, tool returns `"User responded with: X"`
- Agent continues

**Mechanism B (text parsing — legacy/fragile):**
- Model emits `<<ASK>>{"question":"...","options":[...]}<</ASK>>` in text
- `AskCard.tsx` parses it from message text
- Rendered inline in the message body via `splitAroundAsk()`
- No backend roundtrip — clicking sends the choice as a new user message

**Design decision:** Keep Mechanism A (native tool) as the primary flow. Remove Mechanism B (text parsing) unless the model can't be reliably steered to use the tool.

### Task 3.2: Implement popup card UI for ask_question

**Files:**
- Modify: `app/src/components/ChatView.tsx` (render popup card instead of inline list)
- Create: `app/src/components/QuestionCard.tsx` (dedicated popup component)
- Modify: `app/src/lib/store.ts` (pendingQuestion state management)

**Steps:**
1. Create a modal/popup card component that overlays the chat (not inline above composer)
2. Card shows: question text, option buttons (with descriptions), "Other..." text input
3. On submit: `POST /api/chats/:id/answer-question` with selected choice
4. Card blocks interaction with chat until answered (modal overlay)
5. Style based on Vellum/Hermes research

### Task 3.3: Remove <<ASK>> text-parsing legacy

**Files:**
- Modify: `app/src/components/Message.tsx` (remove `splitAroundAsk` usage)
- Modify: `app/src/components/AskCard.tsx` (remove `parseAskPayload`, `splitAroundAsk`)
- Modify: `app/src/lib/api.ts` (remove `<<ASK>>` handling if any)

**Steps:**
1. Remove `splitAroundAsk` calls from Message.tsx
2. Remove `parseAskPayload` and `splitAroundAsk` exports from AskCard.tsx
3. Verify no other code references `<<ASK>>` pattern

---

## Phase 4: UX-Flow Audit & Dead-Element Wiring

### Task 4.1: Audit every view for consistency

**Files:**
- Read: All page components (InboxPage, ScheduledTasksPage, ProjectView, Settings, etc.)
- Read: `app/src/lib/store.ts` (View type definition)

**Steps:**
1. Create a table: View → Header style → Spacing → Empty state → Consistent?
2. Standardize all page headers to match (same height, padding, typography)
3. Standardize empty states (same icon style, message, CTA)
4. Standardize max-width and padding across all pages

### Task 4.2: Wire up dead UI elements

**Files:**
- Modify: `app/src/App.tsx:427` (uncomment `setView("tasks")`)
- Modify: `app/src/components/Sidebar.tsx:187-195` (uncomment Tasks sidebar button)

**Elements to wire:**
- Tasks page (Cmd+J shortcut, sidebar button)
- DailyGoalBar (currently hidden behind comment)
- Any buttons with empty `onClick` handlers

### Task 4.3: Standardize page headers

Create a shared `<PageHeader>` component:
```tsx
<PageHeader title="Inbox" subtitle="..." actions={<Button>...</Button>} />
```

**Files:**
- Create: `app/src/components/PageHeader.tsx`
- Modify: All page components to use it

---

## Phase 5: Surface/Token Hierarchy + Separator Overhaul

**Depends on:** Vellum + Hermes research results

### Task 5.1: Define surface hierarchy taxonomy

**Current tokens (index.css):**
```
--paper          (main background)
--paper-soft     (slightly lighter)
--paper-raised   (cards, modals)
--paper-sunken   (inset areas)
--paper-sidebar  (sidebar)
```

**Steps:**
1. Research how Vellum/Hermes assign surfaces (from research results)
2. Define a strict taxonomy: which surface level for which UI element
3. Document in a design-system markdown file
4. Audit all components against the taxonomy

### Task 5.2: Replace hard separators with spacing-based separation

**Files:**
- Modify: All components with `border-b border-line`, `h-px bg-line`, `divide-y`

**Steps:**
1. Identify every separator usage (from audit: 30+ instances)
2. Replace unnecessary borders with spacing (margin/padding gaps)
3. Keep borders only for: table rows, dropdown menus, intentional visual divides
4. Use softer borders (`border-line/40` instead of `border-line`) where borders are needed

---

## Phase 6: Dead-Code & Tech-Debt Purge

### Task 6.1: Replace .unwrap() with proper error handling

**Files:**
- Modify: `sidecar-rust/src/academic.rs` (many unwraps in format_author_name)
- Modify: `sidecar-rust/src/agent/compaction.rs` (unwrap on payload)
- Modify: `sidecar-rust/src/agent/prompts.rs` (expect on content arrays)
- Modify: `sidecar-rust/src/mcp.rs` (expect on MCP runtime build)

**Steps:**
1. For each `.unwrap()` / `.expect()`: replace with `?` operator or `.unwrap_or_default()`
2. Add `#[cfg(test)]` gates where unwraps are in test code only
3. Run `cargo clippy` and fix all warnings

### Task 6.2: Remove console.log statements

**Files:**
- Search: all `.tsx`/`.ts` files for `console.log` / `console.debug`

### Task 6.3: Remove unused imports and dead code

**Files:**
- Run: `npx tsc --noEmit` and fix all warnings
- Run: `cargo clippy` and fix all warnings

---

## Phase 7: Build, Test, Verify End-to-End

### Task 7.1: Full production build

```bash
cd ~/Programming/zWork/sidecar-rust && cargo build --release
cp target/release/rwork-backend ../app/src-tauri/binaries/zwork-backend-aarch64-apple-darwin
cd ../app && npm run tauri build
```

### Task 7.2: Install and smoke test

```bash
pkill -f "sidecar-app"; pkill -f "zwork-backend"; sleep 2
rm -rf /Applications/zWork.app
cp -R app/src-tauri/target/release/bundle/macos/zWork.app /Applications/zWork.app
xattr -cr /Applications/zWork.app
open -a /Applications/zWork.app
```

**Verification checklist:**
- [ ] App launches without crash-loop
- [ ] Backend health check passes
- [ ] Window is draggable from top 38px strip
- [ ] Sidebar translucency shows desktop wallpaper (when toggled ON)
- [ ] Send a chat message → agent responds
- [ ] Agent can ask a question via popup card
- [ ] Inbox/Scheduled/Projects pages render consistently
- [ ] Settings page works
- [ ] No console errors in dev tools

---

## Execution Order

```
Phase 1 (Window Shell)     ← Research: Tauri docs
    ↓
Phase 2 (Agent Loop)       ← Research: Goose, OpenCode
    ↓
Phase 3 (ask_user)         ← Research: Hermes, Vellum
    ↓
Phase 4 (UX Flows)
    ↓
Phase 5 (Surface Hierarchy) ← Research: Vellum, Hermes
    ↓
Phase 6 (Tech Debt)
    ↓
Phase 7 (Build + Verify)
```

**Rule:** No phase starts until the previous phase's verification passes AND the relevant research results have been consumed.
