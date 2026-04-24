#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DIST_DIR="$ROOT_DIR/dist"
BIN_DIR="$ROOT_DIR/app/src-tauri/binaries"
X64_BACKEND="$BIN_DIR/zwork-backend-x86_64-apple-darwin"
ARM64_BACKEND="$BIN_DIR/zwork-backend-aarch64-apple-darwin"
UNIVERSAL_BACKEND="$BIN_DIR/zwork-backend-universal-apple-darwin"

rm -rf "$DIST_DIR"

if [[ ! -f "$X64_BACKEND" ]]; then
  echo "missing Intel backend: $X64_BACKEND" >&2
  exit 1
fi

if [[ ! -f "$ARM64_BACKEND" ]]; then
  echo "missing Apple Silicon backend: $ARM64_BACKEND" >&2
  exit 1
fi

lipo -create "$X64_BACKEND" "$ARM64_BACKEND" -output "$UNIVERSAL_BACKEND"
chmod +x "$UNIVERSAL_BACKEND"

cd "$ROOT_DIR/app"
npm run tauri -- build --bundles app,dmg --target universal-apple-darwin --ci

"$ROOT_DIR/scripts/package-release.sh" macos universal-apple-darwin
