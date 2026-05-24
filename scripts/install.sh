#!/usr/bin/env bash
set -euo pipefail

REPO="${ZWORK_REPO:-Ryz3nPlayZ/zWork}"
INSTALL_ROOT="${ZWORK_INSTALL_ROOT:-$HOME/.local/share/zWork}"
BIN_DIR="${ZWORK_BIN_DIR:-$HOME/.local/bin}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
esac

asset_name=""
asset_names=()
case "$OS" in
  linux)
    asset_name="zWork-linux-${ARCH}.AppImage"
    asset_names=("$asset_name")
    ;;
  darwin)
    asset_names=("zWork-macos-universal.dmg" "zWork-macos-${ARCH}.dmg")
    ;;
  *)
    echo "unsupported platform: $OS" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
download_path=""
for candidate in "${asset_names[@]}"; do
  candidate_path="$tmp_dir/$candidate"
  if curl -fL "https://github.com/${REPO}/releases/latest/download/${candidate}" -o "$candidate_path"; then
    asset_name="$candidate"
    download_path="$candidate_path"
    break
  fi
done

if [[ -z "$download_path" ]]; then
  echo "could not download a zWork release asset for ${OS}/${ARCH}" >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"

case "$OS" in
  linux)
    install_path="$INSTALL_ROOT/zWork-linux-${ARCH}.AppImage"
    rm -f "$install_path"
    cp "$download_path" "$install_path"
    chmod +x "$install_path"

    # Extract the AppImage and remove bundled shared libraries.
    # The AppImage bundles Ubuntu-built .so files that are ABI-incompatible
    # with other distros (Arch, Fedora, etc.), causing EGL_BAD_PARAMETER crashes.
    # After extraction, the dynamic linker resolves everything from the host system.
    extract_dir="$INSTALL_ROOT/extracted"
    rm -rf "$extract_dir"
    (cd "$tmp_dir" && "$install_path" --appimage-extract >/dev/null 2>&1)
    mv "$tmp_dir/squashfs-root" "$extract_dir"
    find "$extract_dir/usr/lib" -maxdepth 1 -type f -name '*.so*' -delete 2>/dev/null || true
    find "$extract_dir/usr/lib" -type d -empty -delete 2>/dev/null || true

    # Create launcher pointing to the extracted version
    cat > "$BIN_DIR/zwork" << WRAPPER
#!/bin/bash
exec $extract_dir/AppRun "\$@"
WRAPPER
    chmod +x "$BIN_DIR/zwork"
    echo "Installed to $extract_dir"
    echo "Launcher at $BIN_DIR/zwork"
    ;;
  darwin)
    mount_point="$tmp_dir/mount"
    mkdir -p "$mount_point"
    hdiutil attach "$download_path" -nobrowse -quiet -mountpoint "$mount_point"
    app_path="$(find "$mount_point" -maxdepth 1 -name '*.app' | head -n 1)"
    if [[ -z "${app_path:-}" ]]; then
      hdiutil detach "$mount_point" -quiet
      echo "no .app found in dmg" >&2
      exit 1
    fi
    rm -rf "/Applications/$(basename "$app_path")"
    cp -R "$app_path" "/Applications/"
    xattr -dr com.apple.quarantine "/Applications/$(basename "$app_path")" || true
    hdiutil detach "$mount_point" -quiet
    echo "Installed to /Applications/$(basename "$app_path")"
    ;;
esac
