#!/usr/bin/env bash
# zWork — dev launcher.
#
# Starts the Python backend, then boots the Tauri native dev window (which
# in turn runs `vite` for the frontend). Close the window to shut everything
# down cleanly.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# ---- Python backend setup ----
if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python3 -m pip install -q -e .

if [[ -d "../dctl" ]]; then
  echo "Installing sibling dctl repository into virtual environment..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    python3 -m pip install -q -e "../dctl[macos]"
  else
    python3 -m pip install -q -e "../dctl"
  fi
fi

# ---- Frontend deps ----
if [[ ! -d "app/node_modules" ]]; then
  (cd app && npm install)
fi

# ---- Kill stale processes on our ports ----
for port in 8787 1420; do
  pids=$(lsof -ti ":${port}" 2>/dev/null || true)
  if [[ -n "${pids}" ]]; then
    echo "Killing stale process(es) on port ${port}: ${pids}"
    kill -TERM ${pids} 2>/dev/null || true
    sleep 0.5
    kill -9 ${pids} 2>/dev/null || true
  fi
done

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ---- Start backend ----
echo "Starting backend on http://127.0.0.1:8787 ..."
python3 -m sidecar.server >/tmp/zwork-backend.log 2>&1 &
BACKEND_PID=$!

# Wait for backend to be ready
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8787/api/health >/dev/null; then
    echo "Backend ready."
    break
  fi
  sleep 0.2
done

# ---- Launch Tauri dev (opens the native window) ----
echo "Opening zWork desktop window ..."
cd app
# On Linux with system WebKitGTK, skip the software-rendering fallback that
# causes 75-90% CPU usage in WebKitWebProcess. The bundled Ubuntu libs are
# incompatible with other distros' Mesa/EGL stacks.
if [[ "$(uname -s)" == "Linux" ]]; then
  export ZWORK_SYSTEM_WEBKIT=1
fi
npx tauri dev
