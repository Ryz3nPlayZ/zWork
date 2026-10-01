# Backend Code Map

zWork has two backend layers:

- the **local backend** (`sidecar-rust/`, binary `rwork-backend`) that runs on
  the user's machine, spawned by the Tauri shell
- the **cloud API/auth stack** (`cloud-src/`) that runs on the server

For commands, env vars and debugging, see
[DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md). For the agent loop's design, see
[HARNESS.md](HARNESS.md).

## Local backend (`sidecar-rust/src`)

### Entry points

| Path | Role |
|------|------|
| `main.rs` | Startup, logging, CORS, the `x-zwork-token` check, the route table |
| `server.rs` | Most HTTP handlers: chats, settings, providers, projects, files, telemetry |
| `commands.rs` | Slash commands (`/name args`) |
| `crash.rs` | Panic capture to `logs/crashes.jsonl` |

### Agent turn (`agent/`)

| Path | Role |
|------|------|
| `harness_turn.rs` | One chat turn: builds the tool menu, gates risky tools, streams SSE events to the app, caps turns, labels steps |
| `prompts.rs` | Builds the user message from text plus attachments |
| `orientation.rs` | The per-turn context block (time, working directory, git state, turns left) |
| `run_state.rs` | Live runs and pending permission prompts by chat, so the app can reattach to a running turn |
| `trace.rs` | `logs/agent.jsonl`, one line per model/tool call |

### Harness (`harness/`)

A Rust port of pi (pi-agent-core + pi-ai). Specs: `harness/SPEC*.md`.

| Path | Role |
|------|------|
| `providers/` | Wire formats: `anthropic_messages`, `openai_completions`, `openai_responses`, `google_generative_ai`; `catalog.rs` is the models.dev catalog |
| `runtime/` | The crash-safe operation loop: tool execution, hooks, restore |
| `session/` | Durable sessions (SQLite), forks, commits |
| `compaction.rs`, `overflow.rs`, `estimate.rs` | Context-size tracking and summarising old turns |
| `tools/` | Coding tools: read, write, edit, bash, grep, find, ls, web_fetch |
| `skills.rs`, `context_files.rs` | Skill loading and `AGENTS.md`-style instruction files |
| `retry.rs`, `pricing.rs`, `validation.rs`, `transform_messages.rs` | Provider retry, cost, tool-argument coercion, cross-model message cleanup |

### zWork tools and integrations

| Path | Role |
|------|------|
| `tools/mod.rs` | zWork tool schemas (`get_tool_schemas`), dispatch (`execute_tool`), risk rules (`evaluate_tool_risk`) |
| `tools/search.rs`, `academic.rs` | Web and academic search |
| `office.rs`, `fileopen.rs`, `runtime.rs` | Word/Excel editing, opening files in the user's apps, the managed Python runtime |
| `deploy.rs` | `deploy_web_app`: serve a local web app |
| `connectors/` | MCP client (`mcp/`) and Composio (`composio.rs`, via the cloud proxy) |
| `cua/` | Desktop control through the CuaDriver daemon |
| `browser_bridge.rs`, `zbctl.rs` | Chrome control through the zbctl extension (`/ws`) |
| `telegram.rs` | Telegram notifications |

### State on disk

| Path | Role |
|------|------|
| `paths.rs` | Every file path, rooted at `ZWORK_HOME` |
| `settings.rs`, `secretstore.rs` | Settings and API keys |
| `chatstore.rs`, `taskstore.rs`, `inboxstore.rs`, `memory.rs` | Chats, tasks, agent-to-user inbox, memory files |
| `schedulestore.rs`, `scheduler.rs` | Scheduled tasks and the 60-second loop that fires them |
| `watchdog.rs` | Per-chat turn handles, so Stop can abort a run |

### Where to look first

- **Agent loops, stalls or picks the wrong tool:** the run's lines in
  `logs/agent.jsonl`, then `agent/harness_turn.rs`.
- **A model or provider misbehaves:** `harness/providers/` for the wire
  format, `harness/providers/catalog.rs` for the model's limits.
- **Settings or keys don't stick:** `settings.rs`, `secretstore.rs`.
- **Security issue in the local server:** `require_sidecar_token` and
  `cors_layer` in `main.rs`, then `evaluate_tool_risk` in `tools/mod.rs`.

## Cloud stack (`cloud-src/`)

### Top-level files

| Path | Role |
|------|------|
| `docker-compose.yml` | Service topology (api, auth, postgres, caddy) |
| `Caddyfile` | Public host routing |
| `db/schema.sql` | Schema for the app's own tables |

### Cloud API (`api/src/main.rs`)

One file that owns:

- desktop sign-in (`/api/desktop/auth/*`, `/api/auth/*`) and `/api/session`
- the hosted model gateway (`/api/v1/chat/completions`, `/api/v1/messages`)
  with per-tier rate limits and request tracking (`gateway_requests`)
- billing: Stripe checkout, portal and webhook (`/api/billing/*`,
  `/api/webhooks/stripe`)
- the Composio proxy (`/api/composio/*`)
- the admin API (`/api/admin/*`), described in [CLOUD.md](CLOUD.md)
- telemetry forwarding to PostHog (`/api/telemetry/event`) and the web demo
  (`/api/demo/chat`, `/api/web/chats`)

Check it with `SQLX_OFFLINE=true cargo check` in `cloud-src/api`.

### Better Auth service (`auth/`)

| Path | Role |
|------|------|
| `index.ts`, `config.ts` | Better Auth config and providers |
| `entrypoint.sh` | Runs migrations, then starts the service |
| `Dockerfile` | Service image |

### Control points

- `Caddyfile` decides what is publicly reachable. Keep the database host
  blocked.
- The gateway in `api/src/main.rs` decides who can call hosted inference.
  Rate-limit root requests, not the agent's follow-up calls. Upstream
  provider keys come from env, never source.

### Testing

The local backend has far more tests than the cloud stack. Validate a cloud
change touching auth, rate limits or the gateway with `cargo check`, live
endpoint probes, one real desktop sign-in and one hosted-model run.

## See also

- [RESEARCH_TOOLS.md](RESEARCH_TOOLS.md): `detect_hardware`, `check_novelty`,
  `write_research_paper`, `review_paper`
- [CODEMAP_DESKTOP.md](CODEMAP_DESKTOP.md): the frontend and Tauri shell
