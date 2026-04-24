# Releases and packaging

zWork ships as a Tauri desktop app with a Python backend.

## Goals

- low-friction installation from GitHub Releases
- Linux-first desktop packaging
- macOS support without paying for Apple notarization
- persistent user state in `~/.zwork/`

## Linux packaging

Preferred format:

- tar.gz bundle containing the app binary and backend sidecar

Build flow:

```bash
./scripts/build-linux-release.sh
```

That script:

1. builds the backend into a packaged sidecar binary
2. builds the Tauri desktop binary
3. copies the release bundle to `dist/zWork-linux-<arch>.tar.gz`

Install flow:

```bash
curl -fsSL https://raw.githubusercontent.com/Ryz3nPlayZ/zWork/main/scripts/install.sh | bash
```

The installer downloads the latest GitHub Release asset, saves it in
`~/.local/share/zWork/`, and creates a `~/.local/bin/zwork` symlink.

## macOS packaging

Preferred format:

- `.dmg`

Build flow:

```bash
./scripts/build-macos-release.sh
```

The macOS installer flow uses the same `install.sh` script, downloads the
latest DMG, mounts it, and copies the app bundle into `/Applications`.

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

- `zWork-linux-x86_64.tar.gz`
- `zWork-linux-aarch64.tar.gz`
- `zWork-macos-x86_64.dmg`
- `zWork-macos-aarch64.dmg`

## Important constraint

This project does not rely on Apple notarization. That means macOS installs may
still require the user to explicitly open the app the first time, depending on
local Gatekeeper behavior and how the asset was downloaded.
