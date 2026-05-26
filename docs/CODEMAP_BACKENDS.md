# Backend Code Map

zWork has two backend layers:

- the **local sidecar** that runs on the user’s machine
- the **cloud API/auth stack** that runs on your server

## Local sidecar (`sidecar/`)

## Entry points

| Path | Role |
|------|------|
| `sidecar/server.py` | FastAPI server exposed to the desktop app |
| `sidecar/app.py` | lightweight app entrypoint |

## Agent modules

| Path | Responsibility |
|------|----------------|
| `sidecar/agent/settings.py` | persisted settings, model/provider config, telemetry toggle |
| `sidecar/agent/providers.py` | provider/model discovery and normalization |
| `sidecar/agent/chatstore.py` | chat persistence and retrieval |
| `sidecar/agent/projects.py` | project-oriented persistence |
| `sidecar/agent/skills.py` | skill discovery/indexing |
| `sidecar/agent/tools.py` | tool definitions exposed to the model loop; includes academic research pipeline tools (see [RESEARCH_TOOLS.md](RESEARCH_TOOLS.md)) |

## Core orchestration

| Path | Responsibility |
|------|----------------|
| `sidecar/core/orchestrator.py` | builds execution plans from user requests |
| `sidecar/core/executor.py` | executes workflow steps and file operations |
| `sidecar/core/workflows.py` | workflow assembly logic |
| `sidecar/core/artifacts.py` | artifact creation and storage helpers |
| `sidecar/core/activity_log.py` | activity step logging |
| `sidecar/core/models.py` | model-shape helpers |
| `sidecar/core/permission_manager.py` | permission-related decisions |

## What to inspect first

## “Model/tool loop feels wrong”

Start with:

- `sidecar/server.py`
- `sidecar/core/orchestrator.py`
- `sidecar/core/executor.py`

## “Provider or settings bug”

Start with:

- `sidecar/agent/settings.py`
- `sidecar/agent/providers.py`

## “Security issue in local runtime”

Start with:

- `sidecar/server.py`
- `tests/test_security.py`

## Cloud stack (`cloud-src/`)

## Top-level files

| Path | Responsibility |
|------|----------------|
| `cloud-src/docker-compose.yml` | service topology |
| `cloud-src/Caddyfile` | external host routing |
| `cloud-src/db/schema.sql` | bootstrap schema for custom app tables |

## Cloud API

`cloud-src/api/src/main.rs` is the main cloud service. It owns:

- desktop auth start / complete / exchange / logout
- session lookup
- telemetry ingestion
- analytics summary
- coupon redemption
- hosted model gateway proxy
- root-request rate limiting and request tracking

If managed mode, billing readiness, analytics, or desktop auth exchange breaks, this is the first file to inspect.

## Better Auth service

| Path | Role |
|------|------|
| `cloud-src/auth/index.ts` | Better Auth config and provider setup |
| `cloud-src/auth/entrypoint.sh` | startup migration + app boot |
| `cloud-src/auth/Dockerfile` | service image |

## Infra control points

## Public access

- `cloud-src/Caddyfile` decides what is publicly reachable.
- `db.tryzwork.app` should remain blocked unless explicit protection is added.

## Gateway behavior

- `cloud-src/api/src/main.rs` decides who can call hosted inference.
- rate limiting should be based on root requests, not internal continuations.
- upstream provider credentials should come from env, not source.

## Tests and coverage gaps

The repo currently has stronger local sidecar tests than cloud-stack tests.

That means any cloud change with auth, rate limiting, or gateway logic should be validated with:

- local `cargo check`
- live endpoint probes
- one real desktop sign-in test
- one managed-mode end-to-end run

## See also

- [RESEARCH_TOOLS.md](RESEARCH_TOOLS.md) — reference documentation for `detect_hardware`, `check_novelty`, `write_research_paper`, and `review_paper`
