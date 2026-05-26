# Developer Guide

This guide covers common development tasks and workflows for contributing to zWork.

## Quick Reference

| Task | Command |
|------|---------|
| Start dev server | `./run.sh` |
| Run frontend tests | `cd app && npm test` |
| Run backend tests | `.venv/bin/pytest` |
| Build release | `./scripts/build-linux-release.sh` (Linux) |
| Format code | `cd app && npm run format` |
| Lint code | `cd app && npm run lint` |

## Development Workflow

### 1. Making Changes

1. Create a feature branch from `main`
2. Make your changes with clear commit messages
3. Test locally
4. Push and create a pull request

### 2. Commit Messages

Follow conventional commit format:

```
type(scope): description

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

Example:
```
feat(auth): add OAuth callback handler

Implements the Google OAuth callback endpoint that
exchanges auth codes for bearer tokens.

Closes #123
```

### 3. Testing Before Committing

```bash
# Run all backend tests
.venv/bin/pytest

# Run specific test file
.venv/bin/pytest tests/test_home.py

# Run tests with verbose output
.venv/bin/pytest -v

# Run frontend tests
npm test -- --watch
```

## Project Structure

### Frontend (app/)

```
app/
├── src/
│   ├── components/    # Reusable UI components
│   ├── screens/       # Full-page screens (Home, Settings, etc.)
│   ├── hooks/         # Custom React hooks
│   ├── lib/           # Utilities and helpers
│   └── styles/        # Global styles and themes
├── src-tauri/         # Rust desktop shell
└── package.json
```

### Backend (sidecar/)

```
sidecar/
├── agent/
│   ├── academic.py       # Academic research pipeline tools
│   ├── chatstore.py      # Chat persistence (JSONL)
│   ├── compaction.py     # Context compaction helpers
│   ├── composio.py       # Composio integration
│   ├── detect.py         # Local AI tool detection
│   ├── home.py           # Filesystem path helpers
│   ├── mcp.py            # MCP server management
│   ├── projects.py       # Project CRUD
│   ├── providers.py      # Model provider abstraction
│   ├── runlog.py         # Per-run JSONL event log
│   ├── runtime.py        # RunContext and timeouts
│   ├── secretstore.py    # Encrypted secret storage
│   ├── settings.py       # Persisted agent settings
│   ├── skills.py         # Skill discovery and loading
│   ├── streaming.py      # SSE streaming helpers
│   ├── subagent.py       # Sub-agent spawning
│   ├── taskstore.py      # Task CRUD
│   ├── tools.py          # All tool schemas and handlers
│   └── utils.py          # Shared utility functions
└── server.py             # FastAPI server entry point
```

## Common Tasks

### Adding a New Tool

1. Open `sidecar/agent/tools.py`
2. Add a schema dict to `TOOL_SCHEMAS` with `name`, `description`, and `input_schema`
3. Write an async generator handler `_handle_<tool_name>` that yields `status`, `activity`, and `tool_result` events
4. Register the handler in the `execute_tool` dispatch block
5. Add tests in `tests/test_tools.py` or a dedicated `tests/test_<tool_name>.py`
6. Document the tool in `docs/RESEARCH_TOOLS.md` or the relevant docs file

### Adding a New Screen

1. Create screen component in `app/src/screens/`
2. Add route in `app/src/App.tsx`
3. Add navigation link if needed
4. Test on all platforms

### Updating Dependencies

```bash
# Frontend
cd app
npm update
npm audit fix

# Python
pip install --upgrade pip
pip list --outdated
```

## Debugging

### Frontend Debugging

Open DevTools: `Cmd+Option+I` (macOS) or `Ctrl+Shift+I` (Windows/Linux)

### Backend Debugging

```bash
# Run with verbose logging
cd sidecar
uvicorn main:app --log-level debug

# Run with Python debugger
python -m pdb main.py
```

### Desktop Shell Debugging

Check Tauri logs in:
- macOS: `~/Library/Logs/zWork/`
- Windows: `%APPDATA%\zWork\logs\`
- Linux: `~/.local/share/zWork/logs/`

## Platform-Specific Notes

### macOS

- Universal builds require both Intel and ARM binaries
- Notarization is not currently supported (users may see Gatekeeper warnings)
- Code signing is required for auto-update

### Windows

- NSIS installer for distribution
- SmartScreen warnings expected for unsigned builds
- PowerShell scripts may require execution policy changes

### Linux

- AppImage format for distribution
- WebKitGTK compatibility issues on some distributions
- Install script creates symlink in `~/.local/bin/`

## Getting Help

- Check existing [Issues](https://github.com/Ryz3nPlayZ/zWork/issues)
- Start a [Discussion](https://github.com/Ryz3nPlayZ/zWork/discussions)
- Read the [Architecture docs](ARCHITECTURE.md)
- Review [CONTRIBUTING.md](../CONTRIBUTING.md)
