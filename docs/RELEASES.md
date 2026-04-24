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

- `.dmg`

Build flow:

```bash
./scripts/build-macos-release.sh
```

The macOS installer flow uses the same `install.sh` script, downloads the
latest DMG, mounts it, and copies the app bundle into `/Applications`.

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

Suggested names:

- `zWork-linux-x86_64.AppImage`
- `zWork-linux-aarch64.AppImage`
- `zWork-macos-x86_64.dmg`
- `zWork-macos-aarch64.dmg`
- `zWork-windows-x86_64-setup.exe`
- `zWork-windows-aarch64-setup.exe`

## Important constraints

This project does not rely on Apple notarization. That means macOS installs may
still require the user to explicitly open the app the first time, depending on
local Gatekeeper behavior and how the asset was downloaded.

Windows builds are not code-signed. Users may see a SmartScreen warning and need
to click "More info" > "Run anyway".
