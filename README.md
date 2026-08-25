<div align="center">

<img src="app/public/zwork.svg" alt="zWork" width="88" height="88">

# zWork

**A desktop AI agent that does the work on a schedule, inside your apps. It does things. It doesn't just talk.**

[![Release](https://img.shields.io/github/v/release/Ryz3nPlayZ/zWork?style=flat-square&color=171716&labelColor=2a2a2a)](https://github.com/Ryz3nPlayZ/zWork/releases)
[![Platforms](https://img.shields.io/badge/runs%20on-macOS%20%7C%20Windows%20%7C%20Linux-171716?style=flat-square&labelColor=2a2a2a)](#install)
[![License](https://img.shields.io/github/license/Ryz3nPlayZ/zWork?style=flat-square&color=171716&labelColor=2a2a2a)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Ryz3nPlayZ/zWork?style=flat-square&color=171716&labelColor=2a2a2a)](https://github.com/Ryz3nPlayZ/zWork/stargazers)

[**Download**](https://github.com/Ryz3nPlayZ/zWork/releases/latest) &nbsp;·&nbsp; [Docs](docs/WIKI.md) &nbsp;·&nbsp; [Roadmap](docs/ROADMAP.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

</div>

zWork is a desktop AI agent that runs scheduled jobs and integrates with your apps. It can browse the web, edit files, run commands, and create deliverables like documents and spreadsheets.

## How to use

Download from https://github.com/Ryz3nPlayZ/zWork/releases/latest

macOS: .dmg, Windows: .exe, Linux: .AppImage

Or install via command line:

macOS:
```bash
brew install Ryz3nPlayZ/tap/zwork
```

Windows:
```powershell
irm https://raw.githubusercontent.com/Ryz3nPlayZ/zWork/main/scripts/install-windows.ps1 | iex
```

Linux:
```bash
curl -fsSL https://raw.githubusercontent.com/Ryz3nPlayZ/zWork/main/scripts/install.sh | bash
```

Open the app, sign in, and ask it to do something. No prompt engineering needed.

Run from source:
```bash
./run.sh
```

## What it can do

- Scheduled agents: set up recurring jobs (daily digest, inbox sweep, checking sites) and it runs automatically and emails results
- App integrations: connects to Gmail, Calendar, Slack and hundreds of other apps via Composio or MCP
- Desktop & browser control: clicks around macOS apps and drives a browser through an embedded Chrome bridge
- Creates real files: exports .docx/.xlsx/.pdf files, spins up web apps on localhost
- Files, shell, web research: edits files, runs commands, looks things up online
- Skills library: save workflows you like and reuse them later

On-demand and scheduled jobs already work. For more details check docs/ROADMAP.md

## Tech stack

Desktop: Tauri + React
Local engine: Rust (Axum) sidecar
Cloud: Rust (Axum) + Better Auth + Postgres

More docs: docs/ARCHITECTURE.md docs/AUTH.md docs/CLOUD.md docs/RELEASES.md CONTRIBUTING.md

---

v0.5.x · install · sign in · finish a job · update

https://github.com/Ryz3nPlayZ/zWork/releases · https://github.com/Ryz3nPlayZ/zWork/issues · https://github.com/Ryz3nPlayZ/zWork/discussions
