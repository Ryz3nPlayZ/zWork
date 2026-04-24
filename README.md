# zWork

zWork is a desktop AI work assistant built to do real work on a user's machine:
read files, write files, run commands, use skills, and manage ongoing work
through a native app interface.

This repository is the **source tree only**. Build outputs, runtime state,
personal settings, chats, generated files, and local workspaces are intentionally
kept out of git.

![made-with-tauri](https://img.shields.io/badge/built%20with-Tauri%202-black?style=flat-square)
![made-with-fastapi](https://img.shields.io/badge/backend-FastAPI-black?style=flat-square)
![made-with-react](https://img.shields.io/badge/frontend-React%20%2B%20TS-black?style=flat-square)

## V1 focus

zWork v1 is focused on functional desktop-assistant features:

- chat-first task execution
- local file and command workflows
- reusable skills/playbooks
- personalization and memory
- model/provider flexibility

The current product emphasis is capability and reliability first, with UI
polish following after launch.

## Architecture

zWork has three main layers:

- `app/` — Tauri desktop shell + React/TypeScript UI
- `sidecar/` — Python backend that handles chat orchestration, tool execution,
  settings, persistence, and provider integration
- `zWork-Skills/` — the shipped skills library discovered at runtime from
  `SKILL.md` files

High-level request flow:

1. The Tauri app opens the frontend and starts the backend.
2. The frontend streams chat requests to the FastAPI server.
3. The backend builds the system prompt, resolves the selected model, and runs
   the tool/skill loop.
4. Tool activity and streamed output are sent back to the UI in real time.

## Repository layout

```text
app/                   Desktop frontend (Tauri + React + TS)
  src/                 React UI
  src-tauri/           Rust shell that starts the backend

sidecar/               Python backend
  agent/               providers, tools, skills, settings, detection
  core/                planning / execution primitives
  server.py            FastAPI API used by the desktop app

zWork-Skills/          Runtime skills library
tests/                 Backend unit tests
BENCHMARKS.md          Agent benchmark tasks
desktop-agent-prd.md   Product brief / product direction
```

## Runtime data

zWork stores user-specific runtime state outside the repo under `~/.zwork/` by
default, including:

- `settings.json`
- `chats/`
- `projects/`
- `memory.md`
- `zwork.md`
- `workspace/` for generated user work
- logs and other runtime artifacts

This keeps the repository clean and makes packaged desktop behavior match local
development behavior more closely.

## Skills library

The runtime skills library is loaded from `zWork-Skills/`.

Examples currently shipped in this repo include:

- `anthropic-skills/docx`
- `anthropic-skills/pdf`
- `anthropic-skills/xlsx`
- `anthropic-skills/frontend-design`
- `anthropic-skills/web-artifacts-builder`
- `uiux-pro-max`

The backend discovers skills by walking `zWork-Skills/` for `SKILL.md` files.

## Development

### One-command desktop dev

```bash
./run.sh
```

This will:

1. create `.venv/` if missing
2. install the Python package in editable mode
3. install frontend dependencies if needed
4. start the backend on `http://127.0.0.1:8787`
5. open the Tauri desktop app with the Vite dev server

### Split backend/frontend dev

Backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
python3 -m sidecar.server
```

Frontend:

```bash
cd app
npm install
npm run dev
```

### Web mode

```bash
./run-web.sh
```

This builds the frontend and serves both the API and SPA from the Python
backend.

## Models and credentials

zWork supports:

- Anthropic-compatible endpoints
- OpenAI-compatible endpoints
- Claude Code credential reuse

Runtime settings are stored locally in `~/.zwork/settings.json`.

Credentials can come from:

1. local settings saved by the app
2. Claude Code config reuse
3. environment variables

## Tests

Current backend tests:

```bash
python3 -m unittest discover -s tests -v
```

`BENCHMARKS.md` contains higher-level agent tasks used to evaluate product
behavior beyond unit tests.

## Packaging notes

The desktop shell is built with Tauri, and release packaging is now centered on
GitHub Releases.

Current packaging path:

- Linux: tar.gz release bundle
- macOS: DMG
- backend: packaged sidecar binary staged into `app/src-tauri/binaries/`

Build and install helpers live in `scripts/` and are documented in
[docs/RELEASES.md](docs/RELEASES.md).

## Git hygiene

This repository is intended to contain:

- source code
- tests
- skills
- product/docs

It is **not** intended to contain:

- virtual environments
- `node_modules`
- build artifacts
- Rust target output
- local caches
- local chat history
- personal config files
- generated user work

## Credits

zWork uses:

- [Tauri](https://tauri.app)
- [FastAPI](https://fastapi.tiangolo.com)
- [React](https://react.dev)
- [Three.js](https://threejs.org)
- [Anthropic Skills](https://github.com/anthropics/skills)
