#!/usr/bin/env bash
# zWork — dev launcher.
#
# Boots the Tauri native dev window, which runs `vite` for the frontend and
# spawns the Rust backend (rwork-backend) automatically. Close the window to
# shut everything down.
#
# `tauri dev` runs the backend binary staged at
# app/src-tauri/binaries/zwork-backend-<host triple>, not sidecar-rust/ itself.
# This script (re)builds it when it is missing or older than the sidecar
# sources, so a fresh clone works and backend edits take effect. Set
# ZWORK_SKIP_BACKEND_BUILD=1 to run whatever is staged.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${ZWORK_SKIP_BACKEND_BUILD:-}" != "1" ]]; then
  HOST_TRIPLE="$(rustc -vV | awk '/host:/ {print $2}')"
  STAGED="$ROOT_DIR/app/src-tauri/binaries/zwork-backend-$HOST_TRIPLE"
  if [[ ! -x "$STAGED" ]]; then
    echo "No staged backend for $HOST_TRIPLE; building it (first run takes a few minutes)..."
    "$ROOT_DIR/scripts/build-rust-backend.sh"
  elif [[ -n "$(find "$ROOT_DIR/sidecar-rust/src" "$ROOT_DIR/sidecar-rust/Cargo.toml" "$ROOT_DIR/sidecar-rust/Cargo.lock" -newer "$STAGED" -print -quit 2>/dev/null)" ]]; then
    echo "sidecar-rust changed since the staged backend was built; rebuilding..."
    "$ROOT_DIR/scripts/build-rust-backend.sh"
  fi
fi

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
