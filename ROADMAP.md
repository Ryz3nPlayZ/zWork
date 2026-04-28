# zWork Roadmap

This document tracks the high-level direction of zWork. For implementation details, see [PLAN.md](PLAN.md). For a brainstorm of possible future features, see [FUTURE_FEATURES.MD](FUTURE_FEATURES.MD).

---

## Current Release: v0.3.x

Cross-platform desktop AI assistant with chat, file operations, web research, and local execution.

- macOS (Intel + Apple Silicon), Windows, and Linux (AppImage)
- Chat-first interface with streaming responses and activity updates
- Local file management, command execution, and browser automation
- Reusable skills library
- Anonymous telemetry (opt-out) and in-app updater
- BYOK: bring your own OpenAI or Anthropic API key

---

## Near-Term: V1 — Artifact Workspace + Task Surface

**Goal:** Turn chat into a work surface that produces, edits, and organizes deliverables.

| Phase | Focus | Status |
|-------|-------|--------|
| 1 | Artifact Foundation — storage, data model, artifact rail in chat | Planned |
| 2 | Native Doc & Sheet Editors — inline editing for documents and spreadsheets | Planned |
| 3 | Graph Artifacts — chart generation with Python-backed rendering | Planned |
| 4 | Mini Todo + Calendar — compact task board and agenda surface | Planned |
| 5 | Chat-to-Artifact/Task Wiring — chat actions create artifacts and tasks | Planned |
| 6 | Sellable Use Cases — packaged demos for non-technical users | Planned |

**Key principle:** Chat is the entry point, artifacts are the outputs, tasks and calendar are the follow-through.

See [PLAN.md](PLAN.md) for full phase breakdown, acceptance criteria, and implementation targets.

---

## Cloud Infrastructure

Building zWork Cloud (Pro) — zero-config AI endpoints, cross-device sync, and premium workflows.

| Component | Stack | Status |
|-----------|-------|--------|
| API Proxy | Rust (Axum), Postgres | Scaffolding |
| Auth | Better Auth (Node/Bun) | Scaffolding |
| Infrastructure | Caddy reverse proxy, Docker Compose | Scaffolding |
| Billing | Stripe integration | Planned |
| Analytics | PostHog | Planned |

---

## Long-Term Vision

Areas under exploration. Not committed to a timeline.

### Agent Capabilities
- **UI Control & RPA** — find, click, type, and interact with native UI elements
- **Browser Automation** — tab awareness, form filling, download handling
- **Screen Understanding** — OCR, element anchoring, visual change detection

### Productivity Integrations
- **Email & Messaging** — draft, send, summarize threads with approval gates
- **Calendar & Tasks** — schedule proposals, conflict detection, meeting prep
- **App Connectors** — Notion, Slack, Jira, Google Workspace, Microsoft 365

### Data & Knowledge
- **Document Understanding** — PDF/Office parsing, redaction, export pipelines
- **Knowledge Base** — local semantic search, citations, per-project context
- **Data Tools** — CSV/Excel read/write, SQL, ETL transforms, chart generation

### Platform & Safety
- **Workflow Builder** — record/replay, branching, scheduling, templates
- **Safety & Governance** — permission scopes, risk classification, audit trails, dry-run mode
- **Observability** — step traces, reproducible run reports, action explanations

See [FUTURE_FEATURES.MD](FUTURE_FEATURES.MD) for the full brainstorm.
