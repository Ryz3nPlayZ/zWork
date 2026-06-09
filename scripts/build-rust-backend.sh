#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST_TRIPLE="${1:-$(rustc -vV | awk '/host:/ {print $2}')}"
STAGE_DIR="$ROOT_DIR/app/src-tauri/binaries"

mkdir -p "$STAGE_DIR"

echo "Building Rust backend in release mode..."
# Load Rust environment
if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi

cargo build --release --manifest-path "$ROOT_DIR/sidecar-rust/Cargo.toml"

# Stage the Rust backend in place of the Python backend sidecar binary
cp "$ROOT_DIR/sidecar-rust/target/release/rwork-backend" "$STAGE_DIR/zwork-backend-$HOST_TRIPLE"
chmod +x "$STAGE_DIR/zwork-backend-$HOST_TRIPLE"

echo "Rust backend successfully staged at $STAGE_DIR/zwork-backend-$HOST_TRIPLE"
