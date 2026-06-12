$ErrorActionPreference = "Stop"
$ROOT_DIR = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ROOT_DIR

Remove-Item -Recurse -Force "$ROOT_DIR\dist" -ErrorAction SilentlyContinue

# Build Rust backend
$HOST_TRIPLE = ((rustc -vV | Select-String 'host:').Line.Split(' ')[1])
$STAGE_DIR = "$ROOT_DIR\app\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $STAGE_DIR | Out-Null

Write-Host "Building Rust backend in release mode..."
cargo build --release --manifest-path "$ROOT_DIR\sidecar-rust\Cargo.toml"
Copy-Item "$ROOT_DIR\sidecar-rust\target\release\rwork-backend.exe" "$STAGE_DIR\zwork-backend-$HOST_TRIPLE.exe"
Write-Host "Rust backend staged at $STAGE_DIR\zwork-backend-$HOST_TRIPLE.exe"

Set-Location "$ROOT_DIR\app"
npx tauri build --bundles nsis

& "$ROOT_DIR\scripts\package-release.ps1" windows
