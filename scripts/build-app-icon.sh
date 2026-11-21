#!/usr/bin/env bash
# Rebuild app/src-tauri/icons/Assets.car (the macOS icon with its light, dark and tinted looks)
# from app/src-tauri/icons/AppIcon.icon. Needs Xcode. Run after changing the icon, then commit Assets.car.
set -euo pipefail
cd "$(dirname "$0")/../app/src-tauri/icons"
out=$(mktemp -d)
xcrun actool AppIcon.icon --compile "$out" --platform macosx --minimum-deployment-target 10.13 \
  --app-icon AppIcon --output-partial-info-plist "$out/partial.plist" >/dev/null
cp "$out/Assets.car" Assets.car
rm -rf "$out"
echo "Updated $(pwd)/Assets.car"
