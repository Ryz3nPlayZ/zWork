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

zWork is an AI agent that runs on your desktop. It can do scheduled tasks, browse the web, edit files, and work with your apps like Gmail and Slack.

Download it from https://github.com/Ryz3nPlayZ/zWork/releases/latest

Install:

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

Run from source:
```bash
./run.sh
```

What it does:

- Scheduled jobs that run automatically and email you results
- Integrates with Gmail, Calendar, Slack, and other apps
- Can control your desktop and browser
- Creates real files (docs, spreadsheets, etc)
- Edits files and runs commands
- Save workflows to reuse later

Tech: Tauri + React frontend, Rust backend, Postgres cloud

Docs: docs/ARCHITECTURE.md docs/AUTH.md docs/CLOUD.md docs/RELEASES.md CONTRIBUTING.md

v0.5.x

https://github.com/Ryz3nPlayZ/zWork/releases · https://github.com/Ryz3nPlayZ/zWork/issues · https://github.com/Ryz3nPlayZ/zWork/discussions
