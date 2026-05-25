<!-- refreshed: 2026-05-25 -->
# Architecture

**Analysis Date:** 2026-05-25

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (React + Tauri)                │
├──────────────────┬──────────────────┬───────────────────────┤
│   UI Components  │   State (Zustand)│    Pages / Views      │
│  `app/src/components/*`  │  `app/src/lib/store.ts`   │   `app/src/App.tsx`   │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Local Backend (FastAPI / Python)                │
│         `sidecar/server.py` + `sidecar/agent/*`              │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  External: LLM APIs, Cloud Auth, Composio, MCP, dctl        │
│  `cloud-src/api/src/main.rs` (cloud gateway)                │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| App Shell | View routing, auth gate, onboarding gate, keyboard shortcuts, update checks | `app/src/App.tsx` |
| Zustand Store | Global UI state, chat state, side effects (API calls), optimistic updates | `app/src/lib/store.ts` |
| API Client | HTTP client to local backend, SSE stream parsing, Tauri bridge | `app/src/lib/api.ts` |
| Cloud Auth | OAuth / email sign-in, token management, billing, analytics | `app/src/lib/cloud.ts` |
| FastAPI Server | REST API, SSE chat streaming, settings, uploads, projects, tasks | `sidecar/server.py` |
| Provider Harness | Multi-turn LLM loop, tool execution, Anthropic + OpenAI shapes | `sidecar/agent/providers.py` |
| Tool Registry | Tool schemas, gated execution, risk classification | `sidecar/agent/tools.py` |
| Chat Store | Per-chat JSON persistence under `~/.zwork/chats/` | `sidecar/agent/chatstore.py` |
| Runtime Context | Run-scoped logging, process tracking, timeouts | `sidecar/agent/runtime.py` |
| Cloud API (Rust) | Axum gateway, rate limiting, Stripe billing, auth proxy | `cloud-src/api/src/main.rs` |

## Pattern Overview

**Overall:** Desktop-native AI assistant with local Python backend and React frontend, packaged via Tauri. Web fallback mode talks directly to cloud Axum API.

**Key Characteristics:**
- Single-page React app with view-based routing (no React Router)
- Zustand global store with async action methods (no Redux, no RTK Query)
- FastAPI backend exposes REST + SSE; no WebSocket
- Agentic harness: multi-turn tool loop with native tool-calling for both Anthropic and OpenAI shapes
- Conversation compaction: automatic summarization when history grows too long
- Subagent spawning for parallel task execution
- Plan mode: read-only tool subset for safe exploration
- Permission gating: destructive commands require explicit user approval

## Layers

**Presentation Layer (React):**
- Purpose: Render UI, capture user input, display streaming LLM output
- Location: `app/src/components/`
- Contains: Page components, artifact viewers, chat input, modals
- Depends on: Zustand store, API client, Tauri APIs
- Used by: Tauri shell, browser (web mode)

**State Layer (Zustand):**
- Purpose: Global reactive state, orchestrate API calls, cache chats
- Location: `app/src/lib/store.ts`
- Contains: AppState interface, store creator, optimistic updates
- Depends on: API client, cloud auth
- Used by: All React components

**API Client Layer (TypeScript):**
- Purpose: Abstract HTTP transport, handle Tauri vs web vs dev environments
- Location: `app/src/lib/api.ts`
- Contains: `api` object with typed methods, `streamChat` SSE parser
- Depends on: `fetch`, Tauri `invoke`
- Used by: Zustand store

**Backend API Layer (FastAPI):**
- Purpose: Expose REST endpoints and SSE chat stream
- Location: `sidecar/server.py`
- Contains: Pydantic request models, route handlers, static file serving
- Depends on: Agent modules, settings, chatstore
- Used by: Frontend (via HTTP), Tauri launcher

**Agent Harness Layer (Python):**
- Purpose: Execute multi-turn LLM conversations with tool use
- Location: `sidecar/agent/providers.py`
- Contains: `stream_chat`, `_run_anthropic_loop`, `_run_openai_loop`, compaction
- Depends on: Tools, runtime context, settings, projects
- Used by: FastAPI `/api/chat/stream`

**Tool Execution Layer (Python):**
- Purpose: Implement tool schemas, execute commands, gate risky operations
- Location: `sidecar/agent/tools.py`
- Contains: `TOOL_SCHEMAS`, `execute_tool`, `tool_risk`, `_gated_execute_tool`
- Depends on: Runtime context, filesystem, subprocess, dctl
- Used by: Agent harness

**Persistence Layer (Python):**
- Purpose: JSON-file persistence for chats, settings, tasks, projects
- Location: `sidecar/agent/chatstore.py`, `sidecar/agent/taskstore.py`, `sidecar/agent/projects.py`, `sidecar/agent/settings.py`
- Contains: Dataclasses, CRUD functions, file I/O with atomic writes
- Depends on: `home.py` (data directory resolution)
- Used by: FastAPI routes, agent harness

**Cloud Gateway Layer (Rust):**
- Purpose: Hosted API for web users, billing, auth, rate limiting
- Location: `cloud-src/api/src/main.rs`
- Contains: Axum router, Postgres via sqlx, Stripe integration, Composio proxy
- Depends on: Postgres, Stripe, Better Auth service
- Used by: Web frontend, cloud auth flows

## Data Flow

### Primary Chat Request Path

1. User sends message in `ChatInput.tsx` -> calls `useApp.getState().send(text)` (`app/src/lib/store.ts:1288`)
2. Store creates optimistic user message, opens SSE stream via `streamChat()` (`app/src/lib/api.ts:771`)
3. Frontend POSTs to `/api/chat/stream` (`sidecar/server.py:1647`)
4. FastAPI resolves model, builds system prompt, loads project context (`sidecar/server.py:1724`)
5. FastAPI calls `providers.stream_chat()` (`sidecar/agent/providers.py:1019`)
6. Harness runs multi-turn loop: `_run_anthropic_loop` or `_run_openai_loop` (`sidecar/agent/providers.py:1214` / `1405`)
7. Each turn streams deltas back via SSE; tool calls are executed via `execute_tool()` (`sidecar/agent/tools.py`)
8. Results fed back into next turn until model stops or max turns reached
9. FastAPI flushes assistant message to `chatstore` (`sidecar/server.py:1889`)
10. Frontend receives `done`/`end` events, extracts artifacts, updates Zustand state

### Secondary Flow: Web Mode (No Local Backend)

1. `IS_WEB` true in `api.ts` -> `streamChatWeb()` called (`app/src/lib/api.ts:626`)
2. Direct POST to cloud Axum API `/api/v1/messages` with Anthropic-format body
3. Cloud gateway proxies to managed LLM provider
4. SSE deltas translated to same `StreamEvent` types consumed by UI

**State Management:**
- Zustand single store in `app/src/lib/store.ts`
- Server state (chats, settings, providers) cached locally; mutations fire-and-forget with optimistic updates
- Offline fallback: reads from `localStorage` cached chats when backend unreachable

## Key Abstractions

**Artifact:**
- Purpose: Editable deliverable produced by assistant (doc, sheet, graph, code, diff, preview)
- Examples: `app/src/lib/store.ts` (extraction), `app/src/components/artifacts/*`
- Pattern: Serialized in chat messages as `[[ARTIFACT kind=... title=...]]...[[/ARTIFACT]]`

**RunContext:**
- Purpose: Scoped execution context for a single chat turn/run
- Examples: `sidecar/agent/runtime.py`
- Pattern: Dataclass with logging, process tracking, timeout enforcement; stored in `contextvars`

**Provider Shape:**
- Purpose: Abstract Anthropic vs OpenAI API formats
- Examples: `sidecar/agent/providers.py`
- Pattern: Credential resolution -> shape selection -> dedicated turn loop

**StreamEvent:**
- Purpose: Unified SSE event type for frontend consumption
- Examples: `app/src/lib/api.ts:603`
- Pattern: Discriminated union of event types (delta, activity, error, compaction, subagent_*, etc.)

## Entry Points

**Desktop App:**
- Location: `app/src/main.tsx`
- Triggers: Tauri launches, renders React root into `#root`
- Responsibilities: Theme init, PostHog provider wrap, mount `<App />`

**Local Backend:**
- Location: `sidecar/server.py:2197` (`main()`)
- Triggers: Tauri Rust side spawns Python process on port 8787
- Responsibilities: Start uvicorn, acquire PID lock, serve API + static files

**Cloud API:**
- Location: `cloud-src/api/src/main.rs`
- Triggers: Docker / systemd on cloud host
- Responsibilities: Axum server, auth, billing, gateway proxy

## Architectural Constraints

- **Threading:** Python backend is single-process async (asyncio). Subagents run in separate asyncio tasks, not OS threads.
- **Global state:** `_ACTIVE_PROCESSES` set in `sidecar/agent/runtime.py` (module-level mutable state for tracking spawned subprocess PIDs)
- **Circular imports:** None detected. Agent modules use explicit imports; `server.py` has fallback import blocks for PyInstaller.
- **File I/O:** All persistence is JSON files under `~/.zwork/`. No SQLite/Postgres in local backend.
- **Tauri coupling:** Frontend uses `@tauri-apps/api/core` `invoke()` for desktop-only features (screenshots, external links, updater). Web mode guards these with `IS_TAURI` checks.

## Anti-Patterns

### Large Monolithic Components

**What happens:** `App.tsx` is 637 lines, `store.ts` is 1847 lines, `providers.py` is 1571 lines, `tools.py` is 1000+ lines.
**Why it's wrong:** Hard to navigate, high merge conflict surface, difficult to test in isolation.
**Do this instead:** Extract view routing logic from `App.tsx` into a `Router` or `ViewManager`. Split `store.ts` into domain slices (chat, auth, settings, cockpit). Decompose `providers.py` into `anthropic_loop.py`, `openai_loop.py`, `compaction.py`.

### Inline API Client in Store

**What happens:** `store.ts` contains both state definitions and async side-effect methods (API calls, caching, optimistic updates).
**Why it's wrong:** Violates separation of concerns; store becomes a god object.
**Do this instead:** Move API orchestration into a thin service layer (e.g., `app/src/lib/services/chat.ts`) and have store actions delegate to it.

### Fallback Import Blocks

**What happens:** `server.py` and `providers.py` repeat `try/except ImportError` fallback blocks for PyInstaller vs module execution.
**Why it's wrong:** Scattered, error-prone, complicates static analysis.
**Do this instead:** Centralize import resolution in a single `sidecar/agent/compat.py` module.

## Error Handling

**Strategy:** Graceful degradation with user-visible messages.

**Patterns:**
- Backend unreachable -> offline banner, load from `localStorage` cache (`app/src/App.tsx:76`, `app/src/lib/store.ts:851`)
- No model configured -> stream friendly setup message instead of hard 400 (`sidecar/server.py:1684`)
- Provider errors -> yielded as `{"type": "error"}` SSE events, surfaced in chat UI
- Tool execution failures -> caught, logged, returned as `tool_result` with `is_error: true`

## Cross-Cutting Concerns

**Logging:** Python `logging` module; runlog JSONL per run in `~/.zwork/runs/`. Frontend uses `console.warn` for non-fatal errors.
**Validation:** Pydantic models in FastAPI routes. Manual `is_safe_id` checks on all user-supplied IDs (`sidecar/agent/home.py`).
**Authentication:** Cloud auth via JWT in `localStorage` (web) or Tauri secure storage (desktop). Local backend has no auth; relies on localhost binding + CORS.

---

*Architecture analysis: 2026-05-25*
