#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
python3 -m pip install -q -e .
python3 -m pip install -q pyinstaller

HOST_TRIPLE="${1:-$(rustc -vV | awk '/host:/ {print $2}')}"
RELEASE_DIR="$ROOT_DIR/.release"
DIST_DIR="$RELEASE_DIR/backend"
WORK_DIR="$RELEASE_DIR/pyinstaller-work"
SPEC_DIR="$RELEASE_DIR/pyinstaller-spec"
STAGE_DIR="$ROOT_DIR/app/src-tauri/binaries"

mkdir -p "$DIST_DIR" "$WORK_DIR" "$SPEC_DIR" "$STAGE_DIR"

python3 -m PyInstaller \
  --noconfirm \
  --onefile \
  --name zwork-backend \
  --add-data "$ROOT_DIR/zWork-Skills:zWork-Skills" \
  --collect-submodules keyring \
  --collect-submodules keyring.backends \
  --collect-submodules sidecar \
  --hidden-import mcp \
  --hidden-import mcp.client.stdio \
  --hidden-import mcp.types \
  --distpath "$DIST_DIR" \
  --workpath "$WORK_DIR" \
  --specpath "$SPEC_DIR" \
  sidecar/server.py

cp "$DIST_DIR/zwork-backend" "$STAGE_DIR/zwork-backend-$HOST_TRIPLE"
chmod +x "$STAGE_DIR/zwork-backend-$HOST_TRIPLE"

echo "Backend staged at $STAGE_DIR/zwork-backend-$HOST_TRIPLE"
