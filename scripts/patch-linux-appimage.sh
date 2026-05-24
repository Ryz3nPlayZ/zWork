#!/usr/bin/env bash
set -euo pipefail

# Post-process the Linux AppImage to remove all bundled shared libraries
# so they resolve from the host system via ldconfig instead.
#
# The AppImage is built on Ubuntu CI and bundles Ubuntu's libraries.
# These are ABI-incompatible with other distros (Arch, Fedora, etc.),
# causing EGL_BAD_PARAMETER crashes and symbol lookup errors due to
# cascading mismatches between bundled and system libraries (WebKitGTK,
# libepoxy, libsharpyuv, gstreamer, etc.).
#
# We keep only non-library resources (pixbuf loaders, im-modules, GTK
# themes, schemas) and remove all .so files. The Tauri binary, backend,
# and AppRun structure are preserved. At runtime, the dynamic linker
# falls through to ldconfig for all library dependencies.
#
# This makes webkit2gtk-4.1 (and its transitive deps) a runtime dependency,
# which is already the documented requirement for Tauri apps on Linux.
#
# Usage: scripts/patch-linux-appimage.sh <path-to-AppImage>

APPIMAGE="$(readlink -f "${1:-}")"
if [ ! -f "$APPIMAGE" ]; then
    echo "Usage: $0 <path-to-AppImage>" >&2
    exit 1
fi

echo "Patching AppImage: $APPIMAGE"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Download appimagetool if not available
if command -v appimagetool &>/dev/null; then
    TOOL=appimagetool
else
    echo "Downloading appimagetool..."
    curl -fSL -o "$WORK_DIR/appimagetool" \
        "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x "$WORK_DIR/appimagetool"
    TOOL="$WORK_DIR/appimagetool"
fi

export APPIMAGE_EXTRACT_AND_RUN=1

# Extract
chmod +x "$APPIMAGE"
(cd "$WORK_DIR" && "$APPIMAGE" --appimage-extract >/dev/null 2>&1)

SQFS="$WORK_DIR/squashfs-root"

# Remove all bundled shared libraries directly under usr/lib.
# This includes both versioned files (*.so.*) and unversioned/dotted files (*.so, e.g., libgio-2.0.so).
# The dynamic linker will resolve everything from the host via ldconfig.
# We do NOT remove symlinks (type l) because those are typically hooks/loaders or symlinks pointing to subdirectories.
# We do NOT search recursively to avoid deleting plugins/modules inside subfolders (like gdk-pixbuf loaders, GTK immodules, etc.).
removed=$(find "$SQFS/usr/lib" -maxdepth 1 -type f -name '*.so*' -print -delete | wc -l)

# Remove WebKit subprocess binaries — system WebKitGTK spawns its own.
find "$SQFS" -path '*/webkit2gtk-*/WebKitWebProcess' -print -delete
find "$SQFS" -path '*/webkit2gtk-*/WebKitNetworkProcess' -print -delete
find "$SQFS" -path '*/webkit2gtk-*/injected-bundle/*.so' -print -delete

# Clean up empty directories
find "$SQFS/usr/lib" -type d -empty -delete 2>/dev/null || true

echo "Removed $removed bundled libraries"

# Patch the AppRun hook to signal that system libraries are in use.
HOOK="$SQFS/apprun-hooks/linuxdeploy-plugin-gtk.sh"
if [ -f "$HOOK" ] && ! grep -q 'ZWORK_SYSTEM_WEBKIT' "$HOOK"; then
    cat >> "$HOOK" << 'HOOK_PATCH'

# zWork: signal that system WebKitGTK is being used (bundled libs removed).
# This tells the Rust runtime not to force software rendering overrides.
export ZWORK_SYSTEM_WEBKIT=1
HOOK_PATCH
    echo "Patched AppRun hook"
fi

# Repack
"$TOOL" "$SQFS" "$APPIMAGE"
echo "Repacked AppImage: $APPIMAGE"
