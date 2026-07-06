# zWork desktop app

This directory contains the Tauri desktop shell and React frontend for zWork.

## What lives here

- `src/` — React UI
- `src-tauri/` — Rust shell that spawns the Rust backend (`rwork-backend`) and manages cua-driver
- `vite.config.ts` — frontend dev/build config

The frontend talks to the backend over `/api/*`.

## Development

From the repo root, the simplest path is:

```bash
./run.sh
```

If you want to run the pieces separately:

Frontend:

```bash
cd app
npm install
npm run dev
```

Tauri desktop shell (builds frontend, opens the native window, spawns the Rust backend):

```bash
cd app
npm run tauri dev
```

The Rust backend lives in `../sidecar-rust/` — build/run it directly with `cargo run --release` from that directory if you need to iterate on it standalone.

## Runtime behavior

- In development, the frontend runs on Vite and proxies API requests to the backend.
- In desktop mode, the Tauri shell spawns the packaged Rust backend binary.
- User-specific runtime state lives outside the repo under `~/.zwork/`.

For release packaging and GitHub Release install flows, see
[docs/RELEASES.md](../docs/RELEASES.md).

## Frontend scope

The current v1 frontend provides:

- landing / composer flow
- chat view with streaming output
- activity/status updates during tool execution
- settings for models, credentials, memory, and personalization
- sidebar navigation and chat history

## Important note

This repo should only contain source code and related assets. Build output,
`node_modules`, Rust `target/`, generated files, and user workspace data should
not be committed.
