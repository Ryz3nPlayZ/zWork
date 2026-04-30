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
| Local Backend | FastAPI (Python 3.12+) | Agent orchestration, tool execution |
| Cloud API | Rust (Axum) | Auth, telemetry, hosted inference |
| Database | Postgres | User data, sessions, artifacts |
| Auth | Better Auth | OAuth integration, session management |

## Development Setup

### Prerequisites

- **Node.js** 20+ for frontend builds
- **Rust** stable for Tauri and cloud API
- **Python** 3.12+ for the local sidecar
- **Docker** for local cloud infrastructure testing

### Running Locally

```bash
./run.sh
```

This script:
1. Creates a Python virtual environment for the sidecar
2. Installs frontend dependencies
3. Starts the Tauri development window
4. Launches the local FastAPI server

### Development Workflow

```bash
# Frontend dev server (separate terminal)
cd app && npm run dev

# Sidecar dev server with hot reload
cd sidecar && source .venv/bin/activate && uvicorn main:app --reload

# Full desktop build
npm run tauri build
```

## Project Structure

```
zWork/
├── app/                    # Tauri frontend application
│   ├── src/               # React components and logic
│   ├── src-tauri/         # Rust desktop shell
│   └── package.json       # Frontend dependencies
├── sidecar/               # Python FastAPI local backend
│   ├── main.py           # API entry point
│   ├── agents/           # Agent orchestration
│   └── tools/            # Local tool implementations
├── cloud-src/            # Cloud infrastructure source
│   ├── auth/             # Better Auth integration
│   ├── api/              # Rust Axum HTTP handlers
│   └── deploy/           # Docker and deployment configs
├── docs/                 # Project documentation
└── tests/                # Test suites
```

## Contribution Guidelines

### Reporting Issues

When reporting bugs, please include:
- Your operating system and version
- Steps to reproduce the issue
- Expected vs actual behavior
- Relevant logs from the sidecar or Tauri console

### Submitting Changes

1. Fork the repository
2. Create a branch for your feature (`git checkout -b feature/amazing-feature`)
3. Write tests for new functionality
4. Ensure all tests pass (`npm test` && `pytest`)
5. Submit a pull request with a clear description

### Code Style

- **TypeScript**: Follow the existing patterns, use strict mode
- **Python**: PEP 8 compliant, type hints where appropriate
- **Rust**: `cargo fmt` and `cargo clippy` should pass

### Testing

```bash
# Frontend tests
cd app && npm test

# Python backend tests
cd sidecar && pytest

# End-to-end tests
cd tests && pytest e2e/
```

## Building Releases

For information on building release artifacts (`.dmg`, `.exe`, `.AppImage`), see [docs/RELEASES.md](docs/RELEASES.md).

## Documentation

- [Architecture Overview](docs/ARCHITECTURE.md) — System design and data flow
- [Authentication](docs/AUTH.md) — Auth flow and session management
- [Cloud Deployment](docs/CLOUD.md) — Infrastructure and deployment guide
- [Use Cases](docs/USE_CASES.md) — Product framing and target workflows

## Getting Help

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: Questions and community conversation
- **Docs**: See the [docs/](docs/) folder for detailed guides

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
