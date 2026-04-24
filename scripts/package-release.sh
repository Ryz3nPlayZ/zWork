#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:-}"
if [[ -z "$PLATFORM" ]]; then
  echo "usage: package-release.sh linux|macos [host-triple]" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST_TRIPLE="${2:-$(rustc -vV | awk '/host:/ {print $2}')}"
ARCH="${HOST_TRIPLE%%-*}"
DIST_DIR="$ROOT_DIR/dist"
mkdir -p "$DIST_DIR"

case "$PLATFORM" in
  linux)
    APP_BIN="$ROOT_DIR/app/src-tauri/target/release/sidecar-app"
    BACKEND_BIN="$ROOT_DIR/app/src-tauri/binaries/zwork-backend-$HOST_TRIPLE"
    stage="$DIST_DIR/zWork-linux-${ARCH}"
    out="$DIST_DIR/zWork-linux-${ARCH}.tar.gz"
    ;;
  macos)
    BUNDLE_DIR="$ROOT_DIR/app/src-tauri/target/release/bundle/dmg"
    src="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.dmg' | head -n 1)"
    out="$DIST_DIR/zWork-macos-${ARCH}.dmg"
    ;;
  *)
    echo "unknown platform: $PLATFORM" >&2
    exit 1
    ;;
esac

if [[ "$PLATFORM" == "linux" ]]; then
  if [[ ! -f "$APP_BIN" ]]; then
    echo "app binary not found: $APP_BIN" >&2
    exit 1
  fi
  if [[ ! -f "$BACKEND_BIN" ]]; then
    echo "backend binary not found: $BACKEND_BIN" >&2
    exit 1
  fi
  rm -rf "$stage"
  mkdir -p "$stage/binaries"
  cp "$APP_BIN" "$stage/zWork"
  cp "$BACKEND_BIN" "$stage/binaries/"
  chmod +x "$stage/zWork" "$stage/binaries/$(basename "$BACKEND_BIN")"
  tar -C "$DIST_DIR" -czf "$out" "$(basename "$stage")"
  rm -rf "$stage"
  echo "$out"
  exit 0
fi

if [[ -z "${src:-}" || ! -f "$src" ]]; then
  echo "bundle asset not found under $BUNDLE_DIR" >&2
  exit 1
fi

cp "$src" "$out"
chmod +x "$out" || true
echo "$out"
