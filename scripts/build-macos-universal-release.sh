#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DIST_DIR="$ROOT_DIR/dist"
BIN_DIR="$ROOT_DIR/app/src-tauri/binaries"
X64_BACKEND="$BIN_DIR/zwork-backend-x86_64-apple-darwin"
ARM64_BACKEND="$BIN_DIR/zwork-backend-aarch64-apple-darwin"
UNIVERSAL_BACKEND="$BIN_DIR/zwork-backend-universal-apple-darwin"
RESOURCE_DIR="$ROOT_DIR/app/src-tauri/resources/macos-backends"
TAURI_CONF="$ROOT_DIR/app/src-tauri/tauri.conf.json"
TAURI_CONF_BAK="$TAURI_CONF.bak-universal"

rm -rf "$DIST_DIR"
rm -rf "$RESOURCE_DIR"
mkdir -p "$RESOURCE_DIR"

cleanup() {
  if [[ -f "$TAURI_CONF_BAK" ]]; then
    mv "$TAURI_CONF_BAK" "$TAURI_CONF"
  fi
  rm -rf "$RESOURCE_DIR"
}
trap cleanup EXIT

if [[ ! -f "$X64_BACKEND" ]]; then
  echo "missing Intel backend: $X64_BACKEND" >&2
  exit 1
fi

if [[ ! -f "$ARM64_BACKEND" ]]; then
  echo "missing Apple Silicon backend: $ARM64_BACKEND" >&2
  exit 1
fi

cp "$X64_BACKEND" "$RESOURCE_DIR/zwork-backend-x86_64-apple-darwin"
cp "$ARM64_BACKEND" "$RESOURCE_DIR/zwork-backend-aarch64-apple-darwin"
chmod +x "$RESOURCE_DIR"/zwork-backend-*

cat > "$UNIVERSAL_BACKEND" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCE_DIR="$SELF_DIR/../Resources/macos-backends"
if [[ ! -d "$RESOURCE_DIR" ]]; then
  RESOURCE_DIR="$SELF_DIR/../Resources/resources/macos-backends"
fi

case "$(uname -m)" in
  arm64) backend="$RESOURCE_DIR/zwork-backend-aarch64-apple-darwin" ;;
  *) backend="$RESOURCE_DIR/zwork-backend-x86_64-apple-darwin" ;;
esac

if [[ ! -x "$backend" ]]; then
  echo "zWork backend not found for $(uname -m): $backend" >&2
  exit 127
fi

exec "$backend" "$@"
EOF
chmod +x "$UNIVERSAL_BACKEND"

cp "$TAURI_CONF" "$TAURI_CONF_BAK"
python3 - <<'PY'
import json
from pathlib import Path

path = Path("app/src-tauri/tauri.conf.json")
conf = json.loads(path.read_text())
bundle = conf.setdefault("bundle", {})
resources = list(bundle.get("resources") or [])
entry = "resources/macos-backends/*"
if entry not in resources:
    resources.append(entry)
bundle["resources"] = resources
path.write_text(json.dumps(conf, indent=2) + "\n")
PY

cd "$ROOT_DIR/app"
npm run tauri -- build --bundles app,dmg --target universal-apple-darwin --ci

"$ROOT_DIR/scripts/package-release.sh" macos universal-apple-darwin
