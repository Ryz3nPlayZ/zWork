#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cd "$ROOT_DIR/app"
npm run build

cd "$ROOT_DIR/app/src-tauri"
cargo build --release

"$ROOT_DIR/scripts/build-backend.sh"
"$ROOT_DIR/scripts/package-release.sh" linux
