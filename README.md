# zWork

zWork is a desktop AI agent that runs on your computer, can use local tools, and can optionally route through a managed cloud gateway for auth, telemetry, and paid plans.

## What it is

- Desktop app: Tauri + React
- Local runtime: Python FastAPI sidecar
- Optional cloud layer: Axum API + Better Auth + Postgres

The product direction is not “more AI features.” It is “useful desktop jobs that work end to end”:

- research a market and produce a comparison sheet
- turn notes into a brief or follow-up draft
- organize files and clean up folders
- run agentic workflows with tools and visible progress

## Install

Download the latest build from [GitHub Releases](https://github.com/Ryz3nPlayZ/zWork/releases/latest).

- macOS: `zWork-macos-universal.dmg`
- Windows: `zWork-windows-x86_64-setup.exe`
- Linux: `zWork-linux-x86_64.AppImage`

## What works today

- desktop chat UI with streaming responses
- local file and command workflows
- local BYOK model setup
- required account sign-in for managed flows
- analytics/usage view for signed-in users
- in-app updater backed by GitHub release artifacts

## Documentation

- [Wiki / Docs Index](docs/WIKI.md)
- [Architecture Overview](docs/ARCHITECTURE.md)
- [Authentication](docs/AUTH.md)
- [Cloud Deployment](docs/CLOUD.md)
- [Release and Updater Runbook](docs/RELEASES.md)
- [Contributing / local development](CONTRIBUTING.md)

## Development

```bash
./run.sh
```

That bootstraps the local Python sidecar, installs frontend dependencies, and starts the Tauri desktop app in dev mode.

## Product focus

The near-term bar is simple:

- install cleanly
- sign in cleanly
- complete a real task cleanly
- update cleanly

Once that loop is stable, zWork can be packaged around sellable use cases rather than a loose feature list.
