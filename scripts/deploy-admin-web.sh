#!/usr/bin/env bash
# Build and deploy the admin dashboard SPA to admin.tryzwork.app.
#
# What it does:
#   1. Builds the admin-web SPA (Vite → dist/), importing dashboard components
#      from ../app/src/components/admin/
#   2. rsyncs dist/ to /var/www/admin.tryzwork.app on the prod server (Caddy
#      serves that host path; --delete replaces any prior build)
#
# Caddy proxies /api/* on admin.tryzwork.app to axum_api:8080, so the SPA's
# relative API calls hit the same backend as the rest of the product.
#
# The admin endpoints themselves ship in the cloud API (cloud-src/). If the
# endpoint code has changed since the last cloud deploy, rebuild that
# container separately (the script prints a reminder):
#
#     ./ssh-connect.sh 'cd ~/cloud && sudo docker compose up -d --build axum_api caddy'
#
# Host/user/key match ssh-connect.sh (override with the same env vars).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${ZWORK_SERVER_HOST:-api.tryzwork.app}"
USER="${ZWORK_SERVER_USER:-ubuntu}"
KEY="${ZWORK_SERVER_KEY:-${HOME}/.ssh/zwork-server}"
REMOTE_ROOT="/var/www/admin.tryzwork.app"
ADMIN_DIR="$ROOT_DIR/admin-web"

if [ ! -f "$KEY" ]; then
  echo "SSH key not found at $KEY"
  echo "Set ZWORK_SERVER_KEY to point to your key, or place it at ~/.ssh/zwork-server"
  exit 1
fi

if [ ! -d "$ADMIN_DIR" ]; then
  echo "admin-web directory not found at $ADMIN_DIR"
  exit 1
fi

echo "==> Building admin dashboard (admin-web)"
cd "$ADMIN_DIR"
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

# Ensure the target dir exists on the host (first deploy).
# Run via bash -c so the script works regardless of the VM user's default
# login shell (the VM uses fish, which doesn't expand ${USER} the same way).
ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "bash -c 'sudo mkdir -p $REMOTE_ROOT && sudo chown -R \${USER}:\${USER} $REMOTE_ROOT'"

echo "==> Deploying to ${USER}@${HOST}:${REMOTE_ROOT}/"
# --delete so stale assets from a prior build don't linger; the path is a host
# bind-mount into the Caddy container, so files go live immediately.
rsync -avz --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  "$ADMIN_DIR/dist/" \
  "${USER}@${HOST}:${REMOTE_ROOT}/"

echo
echo "==> Deployed. Live at https://admin.tryzwork.app"
echo
echo "NOTE: on first deploy you must also:"
echo "  1. Add a DNS A record for admin.tryzwork.app pointing at the VM"
echo "     (Caddy will auto-provision TLS once DNS resolves)."
echo "  2. Reload Caddy so it picks up the new host:"
echo "       ./ssh-connect.sh 'cd ~/cloud && sudo docker compose up -d --build caddy'"
echo "  3. If admin endpoint code in cloud-src/ changed, rebuild the API too:"
echo "       ./ssh-connect.sh 'cd ~/cloud && sudo docker compose up -d --build axum_api'"
