# Developer Guide

Day-to-day commands, where things live, and how to debug them. For the big
picture read [ARCHITECTURE.md](ARCHITECTURE.md) and, for the agent loop,
[HARNESS.md](HARNESS.md). UI rules are in [design.md](../design.md).

## Quick reference

| Task | Command |
|------|---------|
| Run the desktop app | `./run.sh` |
| Backend tests | `cd sidecar-rust && cargo test` |
| Frontend type-check + build | `cd app && npm run build` |
| Tauri shell check | `cd app/src-tauri && cargo check` |
| Cloud API check | `cd cloud-src/api && SQLX_OFFLINE=true cargo check` |
| Admin dashboard on fake data | `cd admin-web && npm run dev:mock` |
| Landing page | `cd landing && npm run dev` |
| Release build | `scripts/build-<platform>-release.*` (see [scripts/README.md](../scripts/README.md)) |

CI (`.github/workflows/ci.yml`) runs the frontend build, the admin-web
build, `cargo test` in `sidecar-rust`, and `cargo check` for the cloud API and
the Tauri shell. Run the same commands locally before you push.

## The pieces

| Dir | What | Dev port |
|-----|------|----------|
| `app/` | React frontend (`src/`) + Tauri shell (`src-tauri/`) | 1420 (Vite) |
| `sidecar-rust/` | Local backend, binary `rwork-backend`: axum HTTP/SSE server, agent loop, tools | 8787 |
| `cloud-src/` | Cloud API (Rust/axum/sqlx), auth, Postgres, Caddy, docker-compose | |
| `admin-web/` | Admin dashboard SPA, built from `app/src/components/admin` | 4311 |
| `landing/` | Marketing site for tryzwork.app | 4312 |
| `telemetry-collector/` | Optional self-hosted telemetry sink + analyzer | 8765 |
| `bench/` | SWE-bench harness for the coding agent | |
| `zWork-Skills/` | Skills bundled into the app | |
| `scripts/` | Build, release, deploy, install | |

What runs in public, where, and how each host is deployed: [INVENTORY.md](INVENTORY.md).

## How `./run.sh` works

`tauri dev` starts Vite (`npm run dev`, which also runs
`scripts/prepare-bundle.cjs`) and spawns the backend from
`app/src-tauri/binaries/zwork-backend-<host triple>`. That is a **staged
copy** of the release build of `sidecar-rust`, not the crate itself.
`run.sh` rebuilds it with `scripts/build-rust-backend.sh` when it is missing
or older than anything in `sidecar-rust/src`, `Cargo.toml` or `Cargo.lock`.
`ZWORK_SKIP_BACKEND_BUILD=1 ./run.sh` skips that check.

Frontend edits hot-reload. Backend edits need a restart of `./run.sh`, which
rebuilds the backend first.

## Frontend (`app/src`)

- `App.tsx`: top-level layout. The current screen is `view` in the store
  (`"chat" | "settings" | "projects" | …`, see `View` in `lib/store.ts`), not
  a router.
- `lib/store.ts`: the zustand store. Chat streaming, the SSE event handling
  and most app state live here.
- `lib/api.ts`: every call to the local backend (`localFetch`, which adds the
  per-run sidecar token) and to the cloud.
- `components/`: screens and widgets. `components/page/Page.tsx` holds the
  shared page layout and controls (Badge, Button, Segmented, SearchField,
  `useConfirm`…). Use them for new pages; see design.md.
- `components/admin/`: admin dashboard tabs, shared with `admin-web/`.

### Adding a screen

1. Add the name to `View` in `lib/store.ts`.
2. Render it in `App.tsx` where the other views switch on `view`.
3. Add a sidebar entry in `components/Sidebar.tsx` if users should reach it
   directly.
4. Build it on `components/page/Page.tsx` so it matches the other collection
   pages.

## Backend (`sidecar-rust/src`)

| Path | Role |
|------|------|
| `main.rs` | Startup, CORS, the per-run token check, route table |
| `server.rs` | Most HTTP handlers (chats, settings, providers, telemetry…) |
| `agent/harness_turn.rs` | One chat turn on the harness: tool menu, permission gates, SSE events, turn cap, step labels |
| `agent/trace.rs` | Per-run JSONL trace (`logs/agent.jsonl`) |
| `harness/` | Rust port of pi's agent core: loop, providers, compaction, sessions. Specs in `harness/SPEC*.md` |
| `harness/providers/` | Wire formats (Anthropic, OpenAI chat + Responses, Gemini) and the models.dev catalog |
| `harness/tools/` | Coding tools: read, write, edit, bash, grep, find, ls, web_fetch |
| `tools/mod.rs` | zWork tools (web search, schedules, todos, office, connectors…): schemas, dispatch, risk rules |
| `connectors/` | MCP client and Composio |
| `cua/` | Desktop control through the CuaDriver daemon |
| `chatstore.rs`, `taskstore.rs`, `inboxstore.rs`, `schedulestore.rs` | On-disk JSON/JSONL stores |
| `settings.rs`, `secretstore.rs`, `paths.rs` | Settings, encrypted secrets, every file path |

### Adding a tool

There are two kinds:

- **Coding tool** (operates on files or the shell): implement `AgentTool` in
  a new file under `harness/tools/` (copy `web_fetch.rs`) and add it to
  `create_coding_tools` in `harness/tools/mod.rs`.
- **zWork tool** (everything else): add its JSON schema to `get_tool_schemas`
  and a match arm to `execute_tool` in `tools/mod.rs`.

Then, for either kind:
- If the tool writes the user's files or runs commands, add a rule to
  `evaluate_tool_risk` so Ask mode can pause on it.
- Add a human step label in `step_labels` (`agent/harness_turn.rs`).
- Write tests next to the code (`#[cfg(test)]`).
- `ZWORK_CODING_ONLY` (the benchmark mode) uses an allowlist, so a new tool
  stays out of it unless you add it there.

## Where things are on disk

The desktop app keeps everything under one data dir:

| OS | Data dir |
|----|----------|
| macOS | `~/Library/Application Support/zWork` |
| Linux | `~/.local/share/zWork` |
| Windows | `%LOCALAPPDATA%\zWork` |

- `backend.log`: the backend's stdout/stderr, captured by the Tauri shell.
- `state/`: the backend's home (`ZWORK_HOME`). It holds settings, chats,
  `telemetry.jsonl`, `logs/agent.jsonl` and `workspace/`.

A backend you start yourself (`cargo run` in `sidecar-rust`) uses
`~/.zwork` instead, unless you set `ZWORK_HOME`. Point `ZWORK_HOME` at a
scratch dir to test without touching your real chats and settings.

## Debugging

- **Frontend:** in the dev window, right-click → Inspect, or press
  `Cmd+Option+I` / `Ctrl+Shift+I`.
- **Backend logs:** `tail -f "<data dir>/backend.log"`. The default filter is
  `warn,rwork_backend=info,harness=info` (startup, scheduler, MCP and
  provider retries). Set `RUST_LOG` to change it (for example
  `RUST_LOG=rwork_backend=debug,tower_http=info ./run.sh` to also log every
  request); the shell passes its environment through.
- **Crashes:** backend panics go to `<data dir>/state/logs/crashes.jsonl`,
  Tauri-shell panics to `<data dir>/host-crashes.jsonl`.
- **Agent runs:** `<data dir>/state/logs/agent.jsonl` has one line per model
  call and tool call. It is the first place to look when a run loops, stalls or
  picks the wrong tool.
- **Telemetry:** `python telemetry-collector/analyze.py "<data dir>/state/telemetry.jsonl"`.
- **Backend alone:** every endpoint except `/ws` needs the per-run token in an
  `x-zwork-token` header. Without `ZWORK_SIDECAR_TOKEN` the backend makes up
  a random one, so pick your own:

  ```bash
  cd sidecar-rust
  ZWORK_SIDECAR_TOKEN=dev ZWORK_HOME=/tmp/zwork-scratch cargo run
  curl -H 'x-zwork-token: dev' http://127.0.0.1:8787/api/health
  ```

## Backend environment variables

All optional. Set them in the shell before `./run.sh`, because the backend
inherits the app's environment.

| Variable | Effect |
|----------|--------|
| `ZWORK_HOME` | Backend state dir (default `~/.zwork`; the app sets `<data dir>/state`) |
| `ZWORK_PORT`, `ZWORK_HOST` | Listen address (default `127.0.0.1:8787`). The app expects 8787 |
| `ZWORK_MAX_TURNS` | Runaway cap on model calls per turn (default 80, `0` = unbounded) |
| `ZWORK_SUBAGENT_MAX_TURNS` | Same, for sub-agents (default 40) |
| `ZWORK_THINKING` | Reasoning effort for reasoning models: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `ZWORK_CONTEXT_WINDOW` | Token count at which compaction kicks in (default cap 200k) |
| `ZWORK_COMPACTION_MODEL` | Model id for compaction summaries (default: the cheap model of the main model's family) |
| `ZWORK_PARALLEL_TOOLS=1` | Run a turn's tool calls concurrently (off by default) |
| `ZWORK_DISABLE_MODELS_FETCH=1` | Don't refresh the models.dev catalog; use the bundled snapshot |
| `ZWORK_MODELS_URL` | Fetch the catalog from a mirror instead of models.dev |
| `ZWORK_GATEWAY_TOKEN` | zWork router key, used when none is saved in settings |
| `ZWORK_CLOUD_API_BASE` | Composio proxy base URL (default `https://api.tryzwork.app/api/composio`) |
| `ZWORK_IDLE_TEARDOWN_SECS` | Release the CuaDriver daemon after this much idle time (default 1800, `0` = never) |
| `ZWORK_CODING_ONLY` | Benchmark mode: coding tools only, deterministic prompt |
| `ZWORK_ROOT` | Repo root, for finding `zWork-Skills/` when running from source |
| `ZW_TELEMETRY_ENDPOINT` | Also forward telemetry events to this URL (see [TELEMETRY_SETUP.md](TELEMETRY_SETUP.md)) |

The Tauri shell sets `ZWORK_HOME`, `ZWORK_RESOURCES`, `ZWORK_SIDECAR_TOKEN`
and, in dev, `ZWORK_DEV_ORIGIN` itself. Don't set those by hand when you use
`./run.sh`.

## Platform notes

- **macOS:** desktop control needs the CuaDriver daemon and its Accessibility
  and Screen Recording grants. zWork installs it to `~/Applications` on first
  run. Universal builds need both architectures' backends staged.
- **Windows:** NSIS installer. Unsigned builds trigger SmartScreen. The window
  draws its own title bar (`tauri.windows.conf.json`, `TitleBar.tsx`).
- **Linux:** AppImage built against the host's WebKitGTK 4.1 (bundled copies
  are stripped). `run.sh` sets `ZWORK_SYSTEM_WEBKIT=1`.

## Commits

Conventional-ish prefixes are used in history (`app:`, `api:`, `admin:`,
`docs:`, `telemetry:` …): name the area, then say what changed for the
user or developer. Before tagging a release, run
`python3 scripts/check-version-sync.py`.
