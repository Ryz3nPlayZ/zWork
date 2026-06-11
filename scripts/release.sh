#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/.venv/bin/python" "$ROOT_DIR/scripts/check-version-sync.py"

TAG="${1:-v$("$ROOT_DIR/.venv/bin/python" - <<'PY'
import json
from pathlib import Path
print(json.loads(Path("app/package.json").read_text())["version"])
PY
)}"

if [[ ! -d dist ]]; then
  echo "dist/ not found. Build a release first." >&2
  exit 1
fi

assets=()
while IFS= read -r -d '' file; do
  assets+=("$file")
done < <(find dist -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.dmg' -o -name '*.AppImage' -o -name '*.exe' \) -print0)

if [[ ${#assets[@]} -eq 0 ]]; then
  echo "no release assets found in dist/" >&2
  exit 1
fi

"$ROOT_DIR/.venv/bin/python" "$ROOT_DIR/scripts/generate-updater-manifest.py" --dist dist --tag "$TAG" --repo "${ZWORK_REPO:-Ryz3nPlayZ/zWork}" || echo "Warning: updater manifest not generated (no updater-capable assets in dist/ or missing signatures)"

assets=()
while IFS= read -r -d '' file; do
  assets+=("$file")
done < <(find dist -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.dmg' -o -name '*.AppImage' -o -name '*.exe' -o -name '*.sig' -o -name 'latest.json' \) -print0)

gh release create "$TAG" "${assets[@]}" \
  --title "zWork $TAG" \
  --notes "Initial desktop release artifacts for zWork." \
  --latest
