#!/usr/bin/env bash
# zWork — web app launcher.
#
# Builds the frontend, starts the Python backend (which serves the SPA),
# and opens the browser.  Set ZWORK_HOST / ZWORK_PORT to override defaults.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

HOST="${ZWORK_HOST:-0.0.0.0}"
PORT="${ZWORK_PORT:-8787}"

# ---- Python backend setup ----
PYTHON_BIN=".venv/bin/python3"

if [[ ! -x "$PYTHON_BIN" ]]; then
  if [[ -e ".venv" ]]; then
    echo "Recreating broken .venv ..."
    rm -rf .venv
  else
    echo "Creating .venv ..."
  fi
  python3 -m venv .venv
fi

"$PYTHON_BIN" -m pip install -q -e .

if [[ -d "../dctl" ]]; then
  echo "Installing sibling dctl repository into virtual environment..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    "$PYTHON_BIN" -m pip install -q -e "../dctl[macos]"
  else
    "$PYTHON_BIN" -m pip install -q -e "../dctl"
  fi
fi

# ---- Frontend build ----
if [[ ! -d "app/node_modules" ]]; then
  (cd app && npm install)
fi

if [[ ! -d "app/dist/index.html" ]]; then
  echo "Building frontend ..."
  (cd app && npx --no-install vite build --outDir dist)
fi

# ---- Kill stale process on our port ----
pids=$(lsof -ti ":${PORT}" 2>/dev/null || true)
if [[ -n "${pids}" ]]; then
  echo "Killing stale process(es) on port ${PORT}: ${pids}"
  kill -TERM ${pids} 2>/dev/null || true
  sleep 0.5
  kill -9 ${pids} 2>/dev/null || true
fi

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ---- Start backend (serves both API and static frontend) ----
echo "Starting zWork web app on http://${HOST}:${PORT} ..."
ZWORK_HOST="$HOST" ZWORK_PORT="$PORT" "$PYTHON_BIN" -m sidecar.server &
BACKEND_PID=$!

# Wait for backend to be ready, then open browser
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    echo "Backend ready — opening browser."
    xdg-open "http://127.0.0.1:${PORT}" 2>/dev/null || true
    break
  fi
  sleep 0.2
done

wait "$BACKEND_PID"
