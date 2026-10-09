# Scripts

Build, release, deploy and maintenance scripts. Run them from the repository
root (the shell scripts `cd` there themselves, so any cwd works for those).

## Release builds

Each platform build stages the Rust sidecar, runs `tauri build`, then hands the
bundle to `package-release` which writes the final artifact into `dist/`.

| Script | What it does |
|--------|--------------|
| `build-rust-backend.sh [triple]` | Builds `sidecar-rust` in release mode and stages it as `app/src-tauri/binaries/zwork-backend-<triple>` (Tauri's sidecar naming). Defaults to the host triple. |
| `build-macos-release.sh` | Host-arch macOS DMG: backend → `tauri build --bundles dmg` → `package-release.sh macos`. Uses `.cargo_cache` as `CARGO_HOME`. |
| `build-macos-universal-release.sh` | Universal (arm64 + x86_64) DMG. Needs both `zwork-backend-aarch64-apple-darwin` and `-x86_64-apple-darwin` already in `app/src-tauri/binaries`; patches `tauri.conf.json` for the build and restores it. |
| `build-linux-release.sh` | AppImage. Falls back to packaging the AppDir directly if Tauri's AppImage step fails, then runs `patch-linux-appimage.sh`. |
| `build-windows-release.ps1` | Windows installer (PowerShell). |
| `package-release.sh linux\|macos [triple]` | Copies the built bundle into `dist/` under the release asset name (`zWork-<os>-<arch>.*`) that the installers and updater expect. |
| `package-release.ps1 windows [triple]` | Same, for Windows. |
| `patch-linux-appimage.sh` | Strips bundled WebKitGTK/EGL libraries from the AppImage so it links the host's. The CI-built copies are Ubuntu's and crash elsewhere (`EGL_BAD_PARAMETER`, symbol lookup errors); webkit2gtk-4.1 becomes a runtime dependency. |
| `prepare-bundle.cjs` | Stages `zWork-Skills` and `CuaDriver.app` into `src-tauri` and applies `patch-package`. Runs from `app/` as part of `npm run tauri build`; you rarely call it directly. |

## Publishing a release

```bash
python3 scripts/check-version-sync.py   # versions agree?
scripts/release.sh v0.4.2               # needs the artifacts in dist/
```

| Script | What it does |
|--------|--------------|
| `check-version-sync.py` | Fails if `app/package.json`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml` and `sidecar-rust/Cargo.toml` (and the Homebrew cask, if present) disagree on the version. Run before tagging. |
| `generate-updater-manifest.py --tag vX.Y.Z [--dist dist] [--notes …]` | Writes `dist/latest.json` for the Tauri updater from the signed artifacts in `dist/`. Notes default to the matching `CHANGELOG.md` section. |
| `release.sh [tag]` | Runs the version check, generates the updater manifest, and creates the GitHub release with everything in `dist/`, using the version's `CHANGELOG.md` section as the notes. The tag defaults to `v<app/package.json version>`. `ZWORK_REPO` overrides the repo (default `Ryz3nPlayZ/zWork`). |

## Deploying the web surfaces

All three build a Vite SPA and rsync `dist/` to `/var/www/<host>` on the prod
VM, which Caddy serves. Host, user and key match `ssh-connect.sh`
(`ZWORK_SERVER_HOST` etc.). They do **not** redeploy the cloud API; if the
endpoints changed, rebuild `axum_api` too (each script prints the command).

| Script | Deploys | To |
|--------|---------|----|
| `deploy-admin-web.sh` | `admin-web/`, the admin dashboard | admin.tryzwork.app |
| `deploy-app-demo.sh` | `app/` in demo mode (the real UI, desktop features gated off) | app.tryzwork.app |

The landing at tryzwork.app has no script: Vercel deploys `landing/` from git.
Every host and how it ships is in [`docs/INVENTORY.md`](../docs/INVENTORY.md).

## Installers

End-user install scripts. The README points users at them on `main`
(`curl …/main/scripts/install.sh | bash`); they download the platform's asset
from the latest GitHub release, so the asset names in `package-release` must
not change.

| Script | Platform | Overrides |
|--------|----------|-----------|
| `install.sh` | Linux (AppImage) and macOS (DMG) | `ZWORK_REPO`, `ZWORK_INSTALL_ROOT`, `ZWORK_BIN_DIR` |
| `install-macos.sh` | macOS only | `ZWORK_REPO`, `ZWORK_VERSION` |
| `install-windows.ps1` | Windows (`zWork-windows-x86_64-setup.exe`) | `ZWORK_REPO` |

## Maintenance

| Script | What it does |
|--------|--------------|
| `update-models-snapshot.py` | Refreshes the embedded provider/model catalog from models.dev (the offline fallback the sidecar ships; it refreshes itself at runtime every 24h). Commit the result. |
