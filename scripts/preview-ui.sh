#!/usr/bin/env bash
# zWork local design preview.
#
# Hosts two browser preview entry points:
# - auth/onboarding preview on :1420
# - main app preview on :1421
#
# The Python backend still runs on :8787 for any local API calls the preview
# surfaces need.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python3 -m pip install -q -e .

if [[ ! -d "app/node_modules" ]]; then
  (cd app && npm install)
fi

for port in 8787 1420 1421; do
  pids=$(lsof -ti ":${port}" 2>/dev/null || true)
  if [[ -n "${pids}" ]]; then
    echo "Killing stale process(es) on port ${port}: ${pids}"
    kill -9 ${pids} 2>/dev/null || true
  fi
done

cleanup() {
  for pid in "${BACKEND_PID:-}" "${AUTH_PID:-}" "${APP_PID:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

echo "Starting backend on http://127.0.0.1:8787 ..."
python3 -m sidecar.server >/tmp/zwork-backend-preview.log 2>&1 &
BACKEND_PID=$!

for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8787/api/health >/dev/null; then
    echo "Backend ready."
    break
  fi
  sleep 0.2
done

echo "Starting auth/onboarding preview on http://127.0.0.1:1420 ..."
(
  cd app
  VITE_ZWORK_PREVIEW=auth npm run dev -- --host 127.0.0.1 --port 1420 --strictPort
) >/tmp/zwork-preview-auth.log 2>&1 &
AUTH_PID=$!

echo "Starting app preview on http://127.0.0.1:1421 ..."
(
  cd app
  VITE_ZWORK_PREVIEW=app npm run dev -- --host 127.0.0.1 --port 1421 --strictPort
) >/tmp/zwork-preview-app.log 2>&1 &
APP_PID=$!

for i in $(seq 1 40); do
  auth_ok=false
  app_ok=false
  if curl -sf http://127.0.0.1:1420 >/dev/null; then auth_ok=true; fi
  if curl -sf http://127.0.0.1:1421 >/dev/null; then app_ok=true; fi
  if [[ "$auth_ok" == true && "$app_ok" == true ]]; then
    echo "Preview servers ready."
    break
  fi
  sleep 0.25
done

echo "Auth/onboarding preview: http://127.0.0.1:1420"
echo "App preview:            http://127.0.0.1:1421"
echo "Backend:                 http://127.0.0.1:8787"

wait
