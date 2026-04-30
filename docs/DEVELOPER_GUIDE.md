# Developer Guide

This guide covers common development tasks and workflows for contributing to zWork.

## Quick Reference

| Task | Command |
|------|---------|
| Start dev server | `./run.sh` |
| Run frontend tests | `cd app && npm test` |
| Run backend tests | `cd sidecar && pytest` |
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
# Run all tests
npm test && pytest

# Run specific test file
pytest tests/test_auth.py

# Run tests in watch mode
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
├── agents/           # Agent orchestration logic
├── tools/            # Tool implementations
├── api/              # FastAPI endpoints
├── models/           # Pydantic models
└── main.py           # Application entry point
```

## Common Tasks

### Adding a New Tool

1. Create tool file in `sidecar/tools/`
2. Implement the `Tool` protocol
3. Add tool to registry in `sidecar/tools/__init__.py`
4. Add tests in `tests/test_tools.py`
5. Document usage in agent instructions

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
