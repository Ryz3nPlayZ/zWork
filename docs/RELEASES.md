# Releases and packaging

zWork ships as a Tauri desktop app with a Python backend.

## Goals

- low-friction installation from GitHub Releases
- cross-platform: Linux, macOS, and Windows
- persistent user state in platform-appropriate directories

## Linux packaging

Preferred format:

- AppImage bundle containing the app and packaged backend

Build flow:

```bash
./scripts/build-linux-release.sh
```

That script:

1. builds the backend and frontend through Tauri
2. packages the generated AppDir directly with the AppImage plugin
3. copies the release bundle to `dist/zWork-linux-<arch>.AppImage`

Install flow:

```bash
curl -fsSL https://raw.githubusercontent.com/Ryz3nPlayZ/zWork/main/scripts/install.sh | bash
```

The installer downloads the latest GitHub Release asset, saves it in
`~/.local/share/zWork/`, and creates a `~/.local/bin/zwork` symlink.

Linux installs point the symlink directly at the `.AppImage` file.

## macOS packaging

Preferred format:

- universal `.dmg` for Intel and Apple Silicon

Build flow:

```bash
./scripts/build-macos-release.sh
```

GitHub Actions uses:

```bash
./scripts/build-macos-universal-release.sh
```

That script expects both macOS backend sidecars, combines them with `lipo`, runs
Tauri's `universal-apple-darwin` build, and copies:

- `dist/zWork-macos-universal.dmg`
- `dist/zWork-macos-universal.app.tar.gz`
- `dist/zWork-macos-universal.app.tar.gz.sig`

The macOS installer flow uses the same `install.sh` script, downloads the
universal DMG, mounts it, and copies the app bundle into `/Applications`.

## Windows packaging

Preferred format:

- NSIS installer (`.exe`)

Build flow (run on a Windows machine):

```powershell
.\scripts\build-windows-release.ps1
```

That script:

1. builds the Python backend into a single `.exe` via PyInstaller
2. runs `tauri build --bundles nsis`
3. copies the release bundle to `dist/zWork-windows-<arch>-setup.exe`

Install flow:

```powershell
irm https://raw.githubusercontent.com/Ryz3nPlayZ/zWork/main/scripts/install-windows.ps1 | iex
```

Or download the installer from [GitHub Releases](https://github.com/Ryz3nPlayZ/zWork/releases) and run it.

Windows may show a SmartScreen warning for unsigned binaries. Users can click
"More info" > "Run anyway" to proceed.

## Backend bundling

The desktop shell prefers a packaged backend binary in release builds and falls
back to the local Python server in development.

The backend binary is staged under:

```text
app/src-tauri/binaries/zwork-backend-<target-triple>
```

## Release publishing

After a build, upload the files in `dist/` to GitHub Releases.

Helper:

```bash
./scripts/release.sh
```

The release helper now refuses to publish if these drift:

- `app/package.json`
- `app/src-tauri/tauri.conf.json`
- `app/src-tauri/Cargo.toml`

Suggested names:

- `zWork-linux-x86_64.AppImage`
- `zWork-linux-aarch64.AppImage`
- `zWork-linux-x86_64.AppImage.sig`
- `zWork-linux-aarch64.AppImage.sig`
- `zWork-macos-universal.dmg`
- `zWork-macos-universal.app.tar.gz`
- `zWork-macos-universal.app.tar.gz.sig`
- `zWork-macos-x86_64.dmg`
- `zWork-macos-aarch64.dmg`
- `zWork-macos-x86_64.app.tar.gz`
- `zWork-macos-x86_64.app.tar.gz.sig`
- `zWork-macos-aarch64.app.tar.gz`
- `zWork-macos-aarch64.app.tar.gz.sig`
- `zWork-windows-x86_64-setup.exe`
- `zWork-windows-aarch64-setup.exe`
- `zWork-windows-x86_64-setup.exe.sig`
- `zWork-windows-aarch64-setup.exe.sig`
- `latest.json`

## Automatic updates

zWork uses the Tauri updater plugin and checks GitHub Releases for updates at
startup and on a background interval.

Release requirements:

- `bundle.createUpdaterArtifacts` must stay enabled in `tauri.conf.json`
- the updater public key must be committed in `tauri.conf.json`
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must be
  set in GitHub Actions secrets for release builds
- `scripts/generate-updater-manifest.py` writes `dist/latest.json` from the
  platform updater artifacts and signatures
- the macOS universal updater archive is intentionally mapped to both
  `darwin-x86_64` and `darwin-aarch64` in `latest.json`

To create a new keypair:

```bash
cd app
npx tauri signer generate --ci -p '' -w /tmp/zwork-updater.key
```

On this machine the current keypair lives at:

```text
~/.tauri/zwork-updater.key
~/.tauri/zwork-updater.key.pub
```

The homepage update card uses the updater first and falls back to the GitHub
release page only if the native updater is unavailable.

## Important constraints

This project does not rely on Apple notarization. That means macOS installs may
still require the user to explicitly open the app the first time, depending on
local Gatekeeper behavior and how the asset was downloaded.

Windows builds are not code-signed. Users may see a SmartScreen warning and need
to click "More info" > "Run anyway".

## Troubleshooting

### macOS "unidentified developer" warning

If Gatekeeper blocks the app on first launch:

```bash
xattr -cr /Applications/zWork.app
```

Then try launching again.

### Windows SmartScreen warning

Click "More info" → "Run anyway" to proceed. This is expected for unsigned binaries.

### Linux AppImage won't execute

```bash
chmod +x ~/.local/share/zWork/zWork-linux-*.AppImage
```

### Update fails to download

Check the updater logs in:
- macOS: `~/Library/Logs/zWork/`
- Windows: `%APPDATA%\zWork\logs\`
- Linux: `~/.local/share/zWork/logs/`

Manual fallback: Download from [GitHub Releases](https://github.com/Ryz3nPlayZ/zWork/releases).
