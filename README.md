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

## Install

Download from releases: https://github.com/Ryz3nPlayZ/zWork/releases/latest

macOS: .dmg, Windows: .exe, Linux: .AppImage

Command line:

macOS (Homebrew):
```bash
brew install Ryz3nPlayZ/tap/zwork
```

Windows (PowerShell):
```powershell
irm https://raw.githubusercontent.com/Ryz3nPlayZ/zWork/main/scripts/install-windows.ps1 | iex
```

Linux (bash):
```bash
curl -fsSL https://raw.githubusercontent.com/Ryz3nPlayZ/zWork/main/scripts/install.sh | bash
```

Open it, sign in, and ask for something. No prompt engineering required.

Run from source:
```bash
./run.sh
```

## Features

Scheduled agents - set up recurring jobs and it runs on its own and emails you results

App integrations (Composio + MCP) - can reach into Gmail, Calendar, Slack and hundreds of other apps

Desktop & browser control - can click around macOS apps and drive a browser through an embedded Chrome bridge

Real deliverables - can export .docx/.xlsx/.pdf files, spin up a small web app on a localhost URL

Files, shell, web research - can edit files, run local commands, and look stuff up online

Skills library + auto-updates - if a workflow works well once, you can save it and reuse it later

On-demand and scheduled jobs already work. For the rest, check the roadmap: docs/ROADMAP.md

## How it's built

Desktop: Tauri + React
Local engine: Rust (Axum) sidecar
Cloud: Rust (Axum) + Better Auth + Postgres

Architecture: docs/ARCHITECTURE.md Auth: docs/AUTH.md Cloud: docs/CLOUD.md Releases: docs/RELEASES.md Contributing: CONTRIBUTING.md

---

v0.5.x · install · sign in · finish a job · update

Releases: https://github.com/Ryz3nPlayZ/zWork/releases Issues: https://github.com/Ryz3nPlayZ/zWork/issues Discussions: https://github.com/Ryz3nPlayZ/zWork/discussions
