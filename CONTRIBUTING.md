# Contributing to zWork

Thank you for your interest in contributing to zWork! This document covers development setup, contribution guidelines, and project structure.

## Quick Start

```bash
# Clone and enter the directory
git clone https://github.com/Ryz3nPlayZ/zWork.git
cd zWork

# Run the development environment
./run.sh
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop Shell | [Tauri v2](https://tauri.app) | Native window management |
| Frontend | React + TypeScript | Chat UI, settings, artifact views |
| 3D Rendering | Three.js | Visualization features |
| Local Backend | Rust (Axum) | Agent orchestration, tool execution, desktop/browser control |
| Cloud API | Rust (Axum) | Auth, telemetry, hosted inference |
| Database | Postgres | User data, sessions, artifacts |
| Auth | Better Auth | OAuth integration, session management |

## Development Setup

### Prerequisites

- **Node.js** 20+ for frontend builds
- **Rust** stable for the Tauri shell and the local + cloud backends
- **Docker** for local cloud infrastructure testing
- **Python 3** for a few scripts (`scripts/check-version-sync.py`, `telemetry-collector/`)

### Running Locally

```bash
./run.sh
```

This script:
1. Builds and stages the Rust backend if it is missing or older than `sidecar-rust/`
2. Installs frontend dependencies on first run
3. Starts the Tauri development window (which spawns the backend)

Frontend edits hot-reload; backend edits take effect the next time you start
`./run.sh`. The [Developer Guide](docs/DEVELOPER_GUIDE.md) covers the rest:
where things live, adding tools and screens, logs, env vars and debugging.

Release builds go through `scripts/` (see [scripts/README.md](scripts/README.md)),
not `npm run tauri build` directly, because they stage the backend and bundled
resources first.

## Project Structure

```
zWork/
├── app/                   # Desktop app
│   ├── src/               # React frontend (components/, lib/)
│   └── src-tauri/         # Tauri shell: spawns the backend, manages cua-driver
├── sidecar-rust/          # Local backend: axum HTTP/SSE server, agent harness, tools
├── cloud-src/             # Cloud stack
│   ├── api/               # Rust axum API: auth, gateway, billing, admin
│   ├── auth/              # Better Auth service
│   ├── db/                # Postgres schema
│   ├── Caddyfile          # Public routing
│   └── docker-compose.yml # Service topology
├── admin-web/             # Admin dashboard (admin.tryzwork.app)
├── landing/               # Marketing site (tryzwork.app)
├── telemetry-collector/   # Optional self-hosted telemetry sink + analyzer
├── bench/                 # SWE-bench harness
├── zWork-Skills/          # Skills bundled into the app
├── scripts/               # Build, release, deploy, install
└── docs/                  # Documentation
```

## Contribution Guidelines

### Reporting Issues

When reporting bugs, please include:
- Your operating system and version
- Steps to reproduce the issue
- Expected vs actual behavior
- Relevant logs from the backend or Tauri console

### Submitting Changes

1. Fork the repository
2. Create a branch for your feature (`git checkout -b feature/amazing-feature`)
3. Write tests for new functionality
4. Ensure `cargo test` passes in `sidecar-rust/` and `npm run build` passes in `app/` (and in `admin-web/` if you touched `app/src/components/admin` or `page/`)
5. Submit a pull request with a clear description

### Code Style

- **TypeScript**: Follow the existing patterns, use strict mode
- **Rust**: match the surrounding code. The tree is not `rustfmt`-clean yet, so don't reformat whole files you aren't otherwise changing.
- **UI**: follow [design.md](design.md)

### Testing

```bash
# Backend (Rust)
cd sidecar-rust && cargo test

# Frontend type-check + build
cd app && npm run build
```

## Building Releases

For information on building release artifacts (`.dmg`, `.exe`, `.AppImage`), see [docs/RELEASES.md](docs/RELEASES.md).

## Documentation

- [Developer Guide](docs/DEVELOPER_GUIDE.md) — Commands, layout, debugging
- [Architecture Overview](docs/ARCHITECTURE.md) — System design and data flow
- [Backend Code Map](docs/CODEMAP_BACKENDS.md) and [Desktop Code Map](docs/CODEMAP_DESKTOP.md)
- [Authentication](docs/AUTH.md) — Auth flow and session management
- [Cloud Deployment](docs/CLOUD.md) — Infrastructure and deployment guide
- [Use Cases](docs/USE_CASES.md) — Product framing and target workflows

## Getting Help

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: Questions and community conversation
- **Docs**: See the [docs/](docs/) folder for detailed guides

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
