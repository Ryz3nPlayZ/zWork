#!/usr/bin/env bash
# Publish the artifacts in dist/ as a GitHub release.
#
#   scripts/release.sh [tag]     # tag defaults to v<app/package.json version>
#
# Checks that the app versions agree, writes the updater manifest
# (dist/latest.json), then creates the release with the CHANGELOG.md section
# for that version as its notes. Build the platform artifacts first
# (build-*-release.*). ZWORK_REPO overrides the target repo.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

python3 "$ROOT_DIR/scripts/check-version-sync.py"

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

python3 "$ROOT_DIR/scripts/generate-updater-manifest.py" --dist dist --tag "$TAG" --repo "${ZWORK_REPO:-Ryz3nPlayZ/zWork}" || echo "Warning: updater manifest not generated (no updater-capable assets in dist/ or missing signatures)"

assets=()
while IFS= read -r -d '' file; do
  assets+=("$file")
done < <(find dist -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.dmg' -o -name '*.AppImage' -o -name '*.exe' -o -name '*.sig' -o -name 'latest.json' \) -print0)

# Release notes: the CHANGELOG.md section for this version, the same text the
# updater manifest carries, so the GitHub release and the in-app update prompt
# agree.
NOTES_FILE="$(mktemp)"
trap 'rm -f "$NOTES_FILE"' EXIT
python3 - "$TAG" > "$NOTES_FILE" <<'PY'
import re, sys
from pathlib import Path
version = sys.argv[1].removeprefix("v")
text = Path("CHANGELOG.md").read_text(encoding="utf-8")
m = re.search(rf"## v{re.escape(version)}\n(.*?)(?=\n## |\Z)", text, re.DOTALL)
print(m.group(1).strip() if m else "See CHANGELOG.md for details.")
PY

gh release create "$TAG" "${assets[@]}" \
  --title "zWork $TAG" \
  --notes-file "$NOTES_FILE" \
  --latest
