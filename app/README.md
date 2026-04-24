# zWork desktop app

This directory contains the Tauri desktop shell and React frontend for zWork.

## What lives here

- `src/` — React UI
- `src-tauri/` — Rust shell that launches the Python backend
- `vite.config.ts` — frontend dev/build config

The frontend talks to the backend over `/api/*`.

## Development

From the repo root, the simplest path is:

```bash
./run.sh
```

If you want to run the pieces separately:

Backend from repo root:

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

Tauri desktop shell:

```bash
cd app
npm run tauri dev
```

## Runtime behavior

- In development, the frontend runs on Vite and proxies API requests to the
  backend.
- In desktop mode, the Tauri shell starts a packaged backend binary when one is
  available and falls back to the local Python backend in development.
- User-specific runtime state lives outside the repo under `~/.zwork/`.

For release packaging and GitHub Release install flows, see
[docs/RELEASES.md](../docs/RELEASES.md).

## Frontend scope

The current v1 frontend provides:

- landing / composer flow
- chat view with streaming output
- activity/status updates during tool execution
- settings for models, credentials, memory, personalization, and projects
- sidebar navigation and chat history

## Important note

This repo should only contain source code and related assets. Build output,
`node_modules`, Rust `target/`, generated files, and user workspace data should
not be committed.
