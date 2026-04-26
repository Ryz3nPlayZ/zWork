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

if [[ "$HOST_TRIPLE" == *"universal-apple-darwin"* ]]; then
  TARGET_RELEASE_DIR="$ROOT_DIR/app/src-tauri/target/universal-apple-darwin/release"
  ARCH="universal"
else
  TARGET_RELEASE_DIR="$ROOT_DIR/app/src-tauri/target/release"
fi

case "$PLATFORM" in
  linux)
    BUNDLE_DIR="$TARGET_RELEASE_DIR/bundle/appimage"
    out="$DIST_DIR/zWork-linux-${ARCH}.AppImage"
    sig_out="$DIST_DIR/zWork-linux-${ARCH}.AppImage.sig"
    ;;
  macos)
    BUNDLE_DIR="$TARGET_RELEASE_DIR/bundle"
    dmg_dir="$BUNDLE_DIR/dmg"
    macos_dir="$BUNDLE_DIR/macos"
    src="$(find "$dmg_dir" -maxdepth 1 -name '*.dmg' | head -n 1)"
    out="$DIST_DIR/zWork-macos-${ARCH}.dmg"
    updater_src="$(find "$macos_dir" -maxdepth 1 -name '*.app.tar.gz' | head -n 1)"
    updater_out="$DIST_DIR/zWork-macos-${ARCH}.app.tar.gz"
    updater_sig_out="$DIST_DIR/zWork-macos-${ARCH}.app.tar.gz.sig"
    ;;
  windows)
    BUNDLE_DIR="$TARGET_RELEASE_DIR/bundle/nsis"
    src="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*_x64-setup.exe' | head -n 1)"
    out="$DIST_DIR/zWork-windows-${ARCH}-setup.exe"
    sig_out="$DIST_DIR/zWork-windows-${ARCH}-setup.exe.sig"
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

  # Remove bundled WebKitGTK auxiliary processes — they're compiled against
  # the CI environment's libraries and crash on user machines. The system's
  # own WebKitGTK (libwebkit2gtk-4.1) must be used instead.
  rm -rf "$APPDIR/usr/lib/webkit2gtk-4.1" "$APPDIR/usr/lib64/webkit2gtk-4.1"

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
  sig_src="${src}.sig"
  if [[ -f "$sig_src" ]]; then
    cp "$sig_src" "$sig_out"
  elif [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    (
      cd "$ROOT_DIR/app"
      npx tauri signer sign "$out"
    )
    if [[ ! -f "$sig_out" ]]; then
      echo "AppImage signature was not created: $sig_out" >&2
      exit 1
    fi
  fi
  echo "$out"
  exit 0
fi

# macOS / Windows: copy the artifact found in the case statement
if [[ -z "${src:-}" || ! -f "$src" ]]; then
  echo "bundle not found under $BUNDLE_DIR" >&2
  exit 1
fi

cp "$src" "$out"
if [[ "$PLATFORM" == "macos" ]]; then
  if [[ -z "${updater_src:-}" || ! -f "$updater_src" ]]; then
    echo "updater bundle not found under $macos_dir" >&2
    exit 1
  fi
  cp "$updater_src" "$updater_out"
  updater_sig_src="${updater_src}.sig"
  if [[ -f "$updater_sig_src" ]]; then
    cp "$updater_sig_src" "$updater_sig_out"
  fi
fi
sig_src="${src}.sig"
if [[ -f "$sig_src" ]]; then
  cp "$sig_src" "$sig_out"
fi
echo "$out"
