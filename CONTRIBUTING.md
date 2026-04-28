# Contributing to zWork

Welcome to the zWork developer documentation! This file contains the technical details for building and running zWork from source.

## Tech Stack
zWork is built with:
- **Frontend**: [Tauri v2](https://tauri.app), [React](https://react.dev), TypeScript, [Three.js](https://threejs.org)
- **Backend/Sidecar**: [FastAPI](https://fastapi.tiangolo.com) (Python 3.12+)
- **Cloud Infrastructure**: Rust (Axum), Postgres, Better Auth

## Development Setup

If you're building from source, ensure you have Node.js, Rust, and Python installed on your system.

### Running Locally

To set everything up and start the desktop application in development mode:

```bash
./run.sh
```

This script will automatically:
1. Set up the Python virtual environment for the FastAPI sidecar.
2. Install frontend dependencies.
3. Start the Tauri development window.

### Building Releases

For detailed information on building and packaging standalone executables (`.dmg`, `.exe`, `.AppImage`), please refer to [docs/RELEASES.md](docs/RELEASES.md).

## Architecture

zWork operates with a local Rust-based Tauri frontend that spins up a local Python FastAPI "sidecar" to execute agent tasks. The local agent interacts with the `zWork Cloud` via our Rust API proxy for telemetry, paid plan verifications, and secure model routing.
