#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST_TRIPLE="${1:-$(rustc -vV | awk '/host:/ {print $2}')}"
STAGE_DIR="$ROOT_DIR/app/src-tauri/binaries"

mkdir -p "$STAGE_DIR"

echo "Building Rust backend in release mode for $HOST_TRIPLE..."
# Load Rust environment
if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi

CARGO_TARGET_DIR="$ROOT_DIR/sidecar-rust/target"
export CARGO_TARGET_DIR

if [ "$HOST_TRIPLE" = "$(rustc -vV | awk '/host:/ {print $2}')" ]; then
  # Native build — no --target needed
  cargo build --release --manifest-path "$ROOT_DIR/sidecar-rust/Cargo.toml"
  cp "$CARGO_TARGET_DIR/release/rwork-backend" "$STAGE_DIR/zwork-backend-$HOST_TRIPLE"
else
  # Cross-compile for the specified target
  cargo build --release --target "$HOST_TRIPLE" --manifest-path "$ROOT_DIR/sidecar-rust/Cargo.toml"
  cp "$CARGO_TARGET_DIR/$HOST_TRIPLE/release/rwork-backend" "$STAGE_DIR/zwork-backend-$HOST_TRIPLE"
fi

chmod +x "$STAGE_DIR/zwork-backend-$HOST_TRIPLE"

echo "Rust backend successfully staged at $STAGE_DIR/zwork-backend-$HOST_TRIPLE"
