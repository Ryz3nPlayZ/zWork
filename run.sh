#!/usr/bin/env bash
# zWork — dev launcher.
#
# Boots the Tauri native dev window, which runs `vite` for the frontend and
# spawns the Rust backend (rwork-backend) automatically. Close the window to
# shut everything down. The backend is now Rust — no Python venv is needed.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR/app"

if [[ ! -d node_modules ]]; then
  npm install
fi

# On Linux with system WebKitGTK, skip the software-rendering fallback that
# causes 75-90% CPU usage in WebKitWebProcess. The bundled Ubuntu libs are
# incompatible with other distros' Mesa/EGL stacks.
if [[ "$(uname -s)" == "Linux" ]]; then
  export ZWORK_SYSTEM_WEBKIT=1
fi

exec npx tauri dev
