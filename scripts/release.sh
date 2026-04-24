#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TAG="${1:-v$(python3 - <<'PY'
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

gh release create "$TAG" "${assets[@]}" \
  --title "zWork $TAG" \
  --notes "Initial desktop release artifacts for zWork." \
  --latest
