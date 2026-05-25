# Codebase Structure

**Analysis Date:** 2026-05-25

## Directory Layout

```
/home/zemul/Programming/zWork/
├── app/                    # React frontend (Vite + Tauri)
│   ├── src/
│   │   ├── components/     # React components
│   │   │   ├── artifacts/  # Artifact viewers (doc, sheet, code, graph, preview)
│   │   │   ├── cockpit/    # Task/calendar UI (Kanban, DailyAgenda)
│   │   │   └── icons/      # Custom SVG icons
│   │   ├── lib/            # State, API client, utilities
│   │   ├── main.tsx        # React entry point
│   │   ├── App.tsx         # Root app shell
│   │   └── index.css       # Tailwind + custom theme
│   ├── src-tauri/          # Tauri Rust configuration
│   ├── package.json        # Frontend dependencies
│   └── vite.config.ts      # Vite build config
├── sidecar/                # Python backend (FastAPI)
│   ├── server.py           # FastAPI app, routes, SSE streaming
│   └── agent/
│       ├── providers.py    # LLM provider harness (Anthropic/OpenAI)
│       ├── tools.py        # Tool schemas and execution
│       ├── runtime.py      # RunContext, process tracking
│       ├── chatstore.py    # Chat JSON persistence
│       ├── taskstore.py    # Task/event JSON persistence
│       ├── projects.py     # Project JSON persistence
│       ├── settings.py     # Settings JSON persistence
│       ├── compaction.py   # Conversation summarization
│       ├── subagent.py     # Parallel subagent spawning
│       ├── mcp.py          # MCP server manager
│       ├── composio.py     # Composio integration
│       ├── detect.py       # Local credential detection
│       ├── home.py         # Data directory paths
│       ├── skills.py       # Skill loader
│       ├── academic.py     # Academic paper search
│       ├── secretstore.py  # Secret storage (keyring)
│       ├── streaming.py    # Streaming utilities
│       ├── runlog.py       # Per-run JSONL logging
│       ├── env_loader.py   # .env loader
│       └── utils.py        # Small helpers (uid, now_ms)
├── cloud-src/              # Cloud-hosted services
│   ├── api/
│   │   ├── src/main.rs     # Axum gateway (Rust)
│   │   └── Cargo.toml
│   ├── auth/               # Better Auth service (Node/TS)
│   └── db/schema.sql       # Postgres schema
├── tests/                  # Python pytest tests
│   ├── test_*.py           # Unit/integration tests
│   └── __init__.py
├── scripts/                # Build / release scripts
├── docs/                   # Documentation
├── workspace/              # User workspace (outputs, uploads, apps)
├── benchmark-sandbox/      # Benchmarking tools
├── telemetry-collector/    # Telemetry ingestion
├── netlify/functions/      # Netlify edge functions
├── zWork-Skills/           # Skill packs (markdown)
├── .claude/                # Claude Code configuration
├── .planning/              # GSD planning documents
│   └── codebase/
├── pyproject.toml          # Python package metadata
├── run.sh                  # Local dev runner
└── Dockerfile              # Container build
```

## Directory Purposes

**`app/src/components/`:**
- Purpose: React UI components
- Contains: Page-level components, reusable widgets, artifact viewers, cockpit panels
- Key files: `ChatView.tsx`, `Landing.tsx`, `Settings.tsx`, `ArtifactPanel.tsx`, `Message.tsx`

**`app/src/lib/`:**
- Purpose: Frontend business logic and state
- Contains: Zustand store, API client, cloud auth, telemetry, theme, utilities
- Key files: `store.ts`, `api.ts`, `cloud.ts`, `telemetry.ts`, `theme.ts`

**`sidecar/agent/`:**
- Purpose: Python backend agent implementation
- Contains: LLM harness, tools, persistence, integrations
- Key files: `server.py`, `providers.py`, `tools.py`, `runtime.py`, `chatstore.py`

**`cloud-src/api/src/`:**
- Purpose: Cloud gateway for web users
- Contains: Axum Rust server, rate limiting, Stripe billing, auth proxy
- Key files: `main.rs`

**`tests/`:**
- Purpose: Python test suite
- Contains: pytest tests for security, providers, MCP, secret store, etc.
- Key files: `test_security.py`, `test_provider_retry.py`, `test_mcp.py`

**`zWork-Skills/`:**
- Purpose: Markdown skill packs loaded by the agent at runtime
- Contains: Domain-specific instructions and templates

## Key File Locations

**Entry Points:**
- `app/src/main.tsx`: React DOM mount
- `sidecar/server.py:main()`: Uvicorn server startup
- `cloud-src/api/src/main.rs`: Axum server startup

**Configuration:**
- `app/vite.config.ts`: Vite dev server, proxy rules
- `app/tailwind.config.js`: Tailwind theme extensions
- `app/tsconfig.json`: TypeScript compiler options
- `pyproject.toml`: Python deps, entrypoints
- `cloud-src/api/Cargo.toml`: Rust deps

**Core Logic:**
- `app/src/lib/store.ts`: Global state + side effects
- `app/src/lib/api.ts`: HTTP client + SSE parser
- `sidecar/agent/providers.py`: LLM streaming + tool loop
- `sidecar/agent/tools.py`: Tool definitions + execution
- `sidecar/agent/runtime.py`: Execution context + safety

**Testing:**
- `tests/`: All pytest files
- No frontend test suite detected

## Naming Conventions

**Files:**
- React components: PascalCase (`ChatView.tsx`, `ArtifactPanel.tsx`)
- Utilities/hooks: camelCase (`store.ts`, `api.ts`, `cloud.ts`)
- Python modules: snake_case (`chatstore.py`, `providers.py`, `tools.py`)

**Directories:**
- kebab-case for multi-word dirs (`benchmark-sandbox`, `telemetry-collector`)
- Lowercase for simple dirs (`app`, `sidecar`, `tests`, `docs`)

**Types/Interfaces:**
- TypeScript: PascalCase interfaces (`AppState`, `Chat`, `Message`, `StreamEvent`)
- Python: PascalCase dataclasses (`Chat`, `ChatMessage`, `RunContext`, `SubagentTask`)

## Where to Add New Code

**New Feature (frontend):**
- Primary code: `app/src/components/{FeatureName}.tsx`
- State additions: `app/src/lib/store.ts` (add to `AppState` interface and store creator)
- API methods: `app/src/lib/api.ts` (add to `api` object)
- Route integration: `app/src/App.tsx` (add to view switch)

**New Component:**
- Implementation: `app/src/components/{ComponentName}.tsx`
- If reusable widget: export from file, import where needed
- No barrel files used; import directly from component file

**New Backend Endpoint:**
- Route handler: `sidecar/server.py` (add FastAPI route with Pydantic model)
- Business logic: appropriate `sidecar/agent/*.py` module
- If new domain: create `sidecar/agent/{domain}.py`

**New Tool:**
- Schema + implementation: `sidecar/agent/tools.py`
- Add to `TOOL_SCHEMAS` list
- Implement async generator yielding `activity` and `tool_result` events
- Update `tool_risk()` if tool has safety implications

**New Provider / Model Integration:**
- Credential resolution: `sidecar/agent/providers.py` (`resolve()` function)
- If OpenAI-compatible: add entry to `OPENAI_COMPAT_PROVIDERS` dict
- UI model list auto-populates from `/api/providers`

**Utilities:**
- Shared TS helpers: `app/src/lib/cn.ts`, `app/src/lib/constants.ts`
- Shared Python helpers: `sidecar/agent/utils.py`

## Special Directories

**`app/src-tauri/`:**
- Purpose: Tauri v2 configuration and Rust source
- Generated: No (hand-maintained)
- Committed: Yes

**`sidecar.egg-info/`:**
- Purpose: Python package metadata
- Generated: Yes (by setuptools)
- Committed: No

**`.venv/`:**
- Purpose: Python virtual environment
- Generated: Yes
- Committed: No

**`app/dist/`:**
- Purpose: Vite production build output
- Generated: Yes
- Committed: No (served by FastAPI when bundled)

**`workspace/`:**
- Purpose: User-generated outputs, uploads, scratch files
- Generated: Yes (at runtime)
- Committed: No

---

*Structure analysis: 2026-05-25*
