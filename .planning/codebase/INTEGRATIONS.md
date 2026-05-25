# External Integrations

**Analysis Date:** 2026-05-25

## APIs & External Services

**LLM Providers:**
- Anthropic API - Primary provider shape (Anthropic-compatible)
  - SDK/Client: `httpx` (raw HTTP)
  - Auth: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` env var / settings
  - Base URL: `https://api.anthropic.com` (configurable)
  - File: `sidecar/agent/providers.py`

- OpenAI API - OpenAI-compatible provider shape
  - SDK/Client: `httpx` (raw HTTP)
  - Auth: `OPENAI_API_KEY` env var / settings
  - Base URL: `https://api.openai.com/v1` (configurable)
  - File: `sidecar/agent/providers.py`

- DeepSeek API - OpenAI-compatible
  - Base URL: `https://api.deepseek.com/v1`
  - Auth: `DEEPSEEK_API_KEY`
  - File: `sidecar/agent/providers.py`

- Groq API - OpenAI-compatible
  - Base URL: `https://api.groq.com/openai/v1`
  - Auth: `GROQ_API_KEY`
  - File: `sidecar/agent/providers.py`

- Cerebras API - OpenAI-compatible
  - Base URL: `https://api.cerebras.ai/v1`
  - Auth: `CEREBRAS_API_KEY`
  - File: `sidecar/agent/providers.py`

- z.ai API - OpenAI-compatible
  - Base URL: `https://api.z.ai/api/paas/v4`
  - Auth: `ZAI_API_KEY`
  - File: `sidecar/agent/providers.py`

- zWork Router (managed gateway) - Anthropic-compatible
  - Base URL: `https://api.tryzwork.app/api`
  - Auth: `ZWORK_GATEWAY_TOKEN` or `zwork_router` API key in settings
  - File: `sidecar/agent/providers.py`

- Ollama (local) - OpenAI-compatible
  - Base URL: `http://localhost:11434/v1` (default)
  - Auth: None required for localhost
  - File: `sidecar/agent/providers.py`, `sidecar/server.py` (proxy endpoint)

**Cloud Services:**
- zWork Cloud API (`https://api.tryzwork.app`) - Authentication, analytics, billing, web chat persistence
  - Client: `fetch` (frontend), `httpx` (backend)
  - Auth: Bearer token stored in `localStorage` (key: `zwork:cloud-token`)
  - File: `app/src/lib/cloud.ts`, `app/src/lib/api.ts`

- PostHog - Product analytics and telemetry
  - SDK: `@posthog/react`, `posthog-js`
  - Config: `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN`, `VITE_PUBLIC_POSTHOG_HOST`
  - File: `app/src/lib/posthog.ts`, `app/src/main.tsx`

- Composio (via zWork Cloud proxy) - Third-party app integrations
  - Apps: Gmail, Google Calendar, Slack, Notion, Google Drive, GitHub, Jira, Trello, Todoist, Linear, Asana, HubSpot
  - Client: `httpx` (backend proxy to cloud)
  - Auth: zWork cloud token
  - File: `sidecar/agent/composio.py`

**Desktop Control:**
- `dctl` CLI - Desktop automation (screenshots, UI control, browser automation)
  - Invoked via `subprocess.run([sys.executable, "-m", "dctl", ...])`
  - File: `sidecar/agent/tools.py`, `sidecar/server.py`

**Model Context Protocol (MCP):**
- MCP stdio servers - External tool servers
  - Config: `~/.zwork/mcp.json` (Claude Desktop config shape)
  - Client: `mcp` Python SDK (`mcp>=1.0`)
  - File: `sidecar/agent/mcp.py`

## Data Storage

**Databases:**
- None (serverless local app). All data stored as JSON files on local filesystem.

**File Storage:**
- Local filesystem only
  - Data directory: `~/.zwork/` (or `ZWORK_HOME`)
  - Subdirectories:
    - `state/` - Settings, onboarding state, backend PID, activity logs
    - `chats/` - Chat history JSON files
    - `uploads/` - Uploaded file storage
    - `outputs/` - Generated outputs
    - `apps/` - Generated app projects
    - `scratch/` - Temporary work
  - File: `sidecar/agent/home.py`

**Caching:**
- Anthropic prompt caching (ephemeral cache_control) for system prompts and tool schemas
  - File: `sidecar/agent/providers.py`

## Authentication & Identity

**Auth Provider:**
- zWork Cloud (custom) with Google OAuth and email/password
  - Desktop: OAuth via local HTTP callback (port bound dynamically, handled in Rust)
  - Web: Redirect to `https://api.tryzwork.app/api/auth/sign-in/google`
  - Token stored in `localStorage` as `zwork:cloud-token`
  - File: `app/src/lib/cloud.ts`, `app/src-tauri/src/main.rs` (`begin_desktop_auth`)

**Local Credential Reuse:**
- Claude Code CLI config (`~/.claude/settings.json` env block)
- File: `sidecar/agent/detect.py`

## Monitoring & Observability

**Error Tracking:**
- PostHog (optional, controlled by `telemetry_enabled` setting)
- Local telemetry JSONL file: `~/.zwork/telemetry.jsonl`
- File: `app/src/lib/posthog.ts`, `sidecar/server.py`

**Logs:**
- Backend logs to `~/.zwork/backend.log`
- Python `logging` module
- File: `app/src-tauri/src/main.rs` (log appending), `sidecar/server.py`

## CI/CD & Deployment

**Hosting:**
- Desktop: GitHub Releases with Tauri updater
- Web: Caddy reverse proxy to Axum cloud API (inferred from `app/src/lib/api.ts` comments)

**CI Pipeline:**
- Not detected in repository

**Auto-Updater:**
- Tauri plugin-updater with GitHub releases endpoint
  - Endpoint: `https://github.com/Ryz3nPlayZ/zWork/releases/latest/download/latest.json`
  - File: `app/src-tauri/tauri.conf.json`

## Environment Configuration

**Required env vars:**
- None strictly required (app works in onboarding flow to collect credentials)
- For development:
  - `ZWORK_ROOT` (optional) - Repo root for dev backend spawning
  - `ZWORK_PYTHON` (optional) - Custom Python path

**Secrets location:**
- System keyring via `keyring` library (`sidecar/agent/secretstore.py`)
- API keys stored in OS-native secret store; `settings.json` only keeps presence markers
- Cloud token in browser `localStorage`

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- OAuth callback handling (desktop): Local TCP listener on ephemeral port receives Google OAuth code
  - File: `app/src-tauri/src/main.rs` (`begin_desktop_auth`)

---

*Integration audit: 2026-05-25*
