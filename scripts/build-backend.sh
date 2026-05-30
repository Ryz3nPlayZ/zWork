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
export PYINSTALLER_CACHE_DIR="$RELEASE_DIR/pyinstaller-cache"
DIST_DIR="$RELEASE_DIR/backend"
WORK_DIR="$RELEASE_DIR/pyinstaller-work"
SPEC_DIR="$RELEASE_DIR/pyinstaller-spec"
STAGE_DIR="$ROOT_DIR/app/src-tauri/binaries"

mkdir -p "$DIST_DIR" "$WORK_DIR" "$SPEC_DIR" "$STAGE_DIR"

ADD_BINARY_ARGS=()
# dctl can live at ../dctl (local dev) or ./dctl (CI checkout inside workspace)
DCTL_DIR=""
if [[ -d "$ROOT_DIR/../dctl" ]]; then DCTL_DIR="$ROOT_DIR/../dctl"
elif [[ -d "$ROOT_DIR/dctl" ]]; then DCTL_DIR="$ROOT_DIR/dctl"; fi
if [[ -n "$DCTL_DIR" ]]; then
  echo "Installing dctl dependencies from $DCTL_DIR..."
  DCTL_EXTRAS=""
  if [[ "$(uname -s)" == "Darwin" ]]; then DCTL_EXTRAS="[macos]"; fi
  python3 -m pip install -q -e "$DCTL_DIR${DCTL_EXTRAS}"
  echo "Building standalone dctl executable..."
  (
    cd "$DCTL_DIR"
    python3 -m PyInstaller --noconfirm --onefile dctl/__main__.py --name dctl --distpath dist
  )
  ADD_BINARY_ARGS+=("--add-binary" "$DCTL_DIR/dist/dctl:.")
fi

python3 -m PyInstaller \
  --noconfirm \
  --onefile \
  --name zwork-backend \
  --add-data "$ROOT_DIR/zWork-Skills:zWork-Skills" \
  ${ADD_BINARY_ARGS[@]+"${ADD_BINARY_ARGS[@]}"} \
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
