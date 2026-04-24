#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/scripts/build-backend.sh"

cd "$ROOT_DIR/app"
npm run tauri -- build --bundles dmg

"$ROOT_DIR/scripts/package-release.sh" macos
