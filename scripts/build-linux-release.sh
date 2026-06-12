#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

rm -rf "$ROOT_DIR/dist"

"$ROOT_DIR/scripts/build-rust-backend.sh"

cd "$ROOT_DIR/app"
if ! APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --bundles appimage --ci; then
  echo "tauri appimage bundling failed; packaging the generated AppDir directly" >&2
fi

# Post-process the AppImage: remove bundled WebKitGTK/EGL libs that crash
# on non-Ubuntu distros. Must run before package-release.sh copies to dist/.
APPIMAGE_CANDIDATE=$(find "$ROOT_DIR/app/src-tauri/target/release/bundle/appimage" -name 'zWork_*.AppImage' -type f | head -1)
if [ -n "$APPIMAGE_CANDIDATE" ]; then
  "$ROOT_DIR/scripts/patch-linux-appimage.sh" "$APPIMAGE_CANDIDATE"
fi

"$ROOT_DIR/scripts/package-release.sh" linux
