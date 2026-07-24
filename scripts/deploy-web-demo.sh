#!/usr/bin/env bash
# Build and deploy the public web chat demo to app.tryzwork.app.
#
# What it does:
#   1. Builds the minimal-chat SPA (Vite → dist/)
#   2. rsyncs dist/ to /var/www/app.tryzwork.app on the prod server (Caddy
#      serves that host path; --delete replaces any prior build)
#
# The demo's /api/demo/chat endpoint ships in the cloud API (cloud-src/). If
# the endpoint code has changed since the last cloud deploy, rebuild that
# container separately (the script prints a reminder):
#
#     ./ssh-connect.sh 'cd ~/cloud && sudo docker compose up -d --build axum_api'
#
# Host/user/key match ssh-connect.sh (override with the same env vars).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${ZWORK_SERVER_HOST:-api.tryzwork.app}"
USER="${ZWORK_SERVER_USER:-ubuntu}"
KEY="${ZWORK_SERVER_KEY:-${HOME}/.ssh/zwork-server}"
REMOTE_ROOT="/var/www/app.tryzwork.app"
DEMO_DIR="$ROOT_DIR/minimal-chat"

if [ ! -f "$KEY" ]; then
  echo "SSH key not found at $KEY"
  echo "Set ZWORK_SERVER_KEY to point to your key, or place it at ~/.ssh/zwork-server"
  exit 1
fi

if [ ! -d "$DEMO_DIR" ]; then
  echo "minimal-chat directory not found at $DEMO_DIR"
  exit 1
fi

echo "==> Building demo (minimal-chat)"
cd "$DEMO_DIR"
if [ -d node_modules ]; then
  npm run build
else
  npm ci && npm run build
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
  "$DEMO_DIR/dist/" \
  "${USER}@${HOST}:${REMOTE_ROOT}/"

echo
echo "==> Deployed. Live at https://app.tryzwork.app"
echo
echo "NOTE: if you changed cloud-src/ (the /api/demo/chat endpoint), rebuild"
echo "the API container once:"
echo "    ./ssh-connect.sh 'cd ~/cloud && sudo docker compose up -d --build axum_api'"
