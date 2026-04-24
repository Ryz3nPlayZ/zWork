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
    BUNDLE_DIR="$ROOT_DIR/app/src-tauri/target/release/bundle/appimage"
    out="$DIST_DIR/zWork-linux-${ARCH}.AppImage"
    ;;
  macos)
    BUNDLE_DIR="$ROOT_DIR/app/src-tauri/target/release/bundle/dmg"
    src="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.dmg' | head -n 1)"
    out="$DIST_DIR/zWork-macos-${ARCH}.dmg"
    ;;
  windows)
    BUNDLE_DIR="$ROOT_DIR/app/src-tauri/target/release/bundle/nsis"
    src="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*_x64-setup.exe' | head -n 1)"
    out="$DIST_DIR/zWork-windows-${ARCH}-setup.exe"
    ;;
  *)
    echo "unknown platform: $PLATFORM" >&2
    exit 1
    ;;
esac

if [[ "$PLATFORM" == "linux" ]]; then
  APPDIR="$BUNDLE_DIR/zWork.AppDir"
  PLUGIN="$HOME/.cache/tauri/linuxdeploy-plugin-appimage.AppImage"

  if [[ ! -d "$APPDIR" ]]; then
    echo "AppDir not found: $APPDIR" >&2
    exit 1
  fi
  if [[ ! -x "$PLUGIN" ]]; then
    echo "AppImage plugin not found: $PLUGIN" >&2
    exit 1
  fi

  ln -sf zWork.png "$APPDIR/sidecar-app.png"
  (
    cd "$BUNDLE_DIR"
    APPIMAGE_EXTRACT_AND_RUN=1 "$PLUGIN" --appdir "$APPDIR"
  )

  src="$(python3 - "$BUNDLE_DIR" <<'PY'
import sys
from pathlib import Path

bundle_dir = Path(sys.argv[1])
candidates = []
for root in [Path("/tmp"), bundle_dir]:
    if not root.exists():
        continue
    for path in root.rglob("zWork-*.AppImage"):
        try:
            if path.is_file():
                candidates.append((path.stat().st_mtime, str(path)))
        except OSError:
            pass

if candidates:
    candidates.sort()
    print(candidates[-1][1])
PY
)"
  if [[ -z "${src:-}" || ! -f "$src" ]]; then
    echo "AppImage bundle not found under $BUNDLE_DIR" >&2
    exit 1
  fi

  cp "$src" "$out"
  chmod +x "$out" || true
  echo "$out"
  exit 0
fi

# macOS / Windows: copy the artifact found in the case statement
if [[ -z "${src:-}" || ! -f "$src" ]]; then
  echo "bundle not found under $BUNDLE_DIR" >&2
  exit 1
fi

cp "$src" "$out"
echo "$out"
