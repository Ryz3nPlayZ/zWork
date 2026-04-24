#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

rm -rf "$ROOT_DIR/dist"

"$ROOT_DIR/scripts/build-backend.sh"

cd "$ROOT_DIR/app"
if ! APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --bundles appimage --ci; then
  echo "tauri appimage bundling failed; packaging the generated AppDir directly" >&2
fi

"$ROOT_DIR/scripts/package-release.sh" linux
