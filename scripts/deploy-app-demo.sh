#!/usr/bin/env bash
# Build and deploy the REAL desktop app (app/) as the public chat demo at
# app.tryzwork.app, with desktop-only features disabled at runtime via the
# demo-mode gating in app/src/lib/preview.ts.
#
# What it does:
#   1. Builds the app/ SPA (Vite → dist/) WITHOUT the Tauri-specific
#      prepare-bundle step (that only stages src-tauri resources). The demo
#      activates on the app.tryzwork.app origin automatically — no flag needed.
#   2. rsyncs dist/ to /var/www/app.tryzwork.app on the prod server (Caddy
#      serves that host path; --delete replaces any prior build).
#
# The demo's /api/demo/chat endpoint ships in the cloud API (cloud-src/). If
# the endpoint code has changed since the last cloud deploy, rebuild that
# container separately:
#   rsync cloud-src/api → server, then
#   ./ssh-connect.sh 'cd ~/cloud && sudo docker compose up -d --build axum_api'
#
# Host/user/key match ssh-connect.sh (override with the same env vars).
#
# NOTE: the desktop app (npm run tauri build) is UNAFFECTED by this script.
# Demo gating is runtime/origin-based; the same source builds both targets.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${ZWORK_SERVER_HOST:-api.tryzwork.app}"
USER="${ZWORK_SERVER_USER:-ubuntu}"
KEY="${ZWORK_SERVER_KEY:-${HOME}/.ssh/zwork-server}"
REMOTE_ROOT="/var/www/app.tryzwork.app"
APP_DIR="$ROOT_DIR/app"

if [ ! -f "$KEY" ]; then
  echo "SSH key not found at $KEY"
  echo "Set ZWORK_SERVER_KEY to point to your key, or place it at ~/.ssh/zwork-server"
  exit 1
fi

if [ ! -d "$APP_DIR" ]; then
  echo "app/ directory not found at $APP_DIR"
  exit 1
fi

echo "==> Building app/ demo (web bundle, skips Tauri prepare-bundle)"
cd "$APP_DIR"
if [ -d node_modules ]; then
  # Build the web bundle directly — no prepare-bundle (it only stages
  # src-tauri resources that never enter the Vite graph).
  npx vite build
else
  npm ci && npx vite build
fi

if [ ! -d dist ]; then
  echo "Build failed: dist/ not produced"
  exit 1
fi

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new)

echo "==> Deploying to ${USER}@${HOST}:${REMOTE_ROOT}/"
# --delete so stale assets from a prior build don't linger; the path is a host
# bind-mount into the Caddy container, so files go live immediately.
rsync -avz --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  "$APP_DIR/dist/" \
  "${USER}@${HOST}:${REMOTE_ROOT}/"

echo
echo "==> Deployed. Live at https://app.tryzwork.app"
echo
echo "NOTE: if you changed cloud-src/ (the /api/demo/chat endpoint), rebuild"
echo "the API container once:"
echo "    ./ssh-connect.sh 'cd ~/cloud && sudo docker compose up -d --build axum_api'"
