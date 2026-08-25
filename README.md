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

## What it does

You tell zWork what you want done, and it does it. A few examples:

- Compare three vacuum cleaners → you get a side-by-side comparison sheet. Not a lecture about "features and reviews."
- Yesterday's meeting notes → a follow-up email draft you can actually send.
- Your Downloads folder is a mess → it sorts it into subfolders while you watch.

So instead of advice, you get the result. That's the idea, anyway.

## Install

Download the app for your platform:

macOS: Download .dmg from [releases](https://github.com/Ryz3nPlayZ/zWork/releases/latest)
Windows: Download .exe from [releases](https://github.com/Ryz3nPlayZ/zWork/releases/latest)
Linux: Download .AppImage from [releases](https://github.com/Ryz3nPlayZ/zWork/releases/latest)

Or use command line:

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

Scheduled agents - set up recurring jobs (daily digest, inbox sweep, checking a site) and it runs on its own and emails you the results. You can walk away, nobody has to watch it.

App integrations (Composio + MCP) - can reach into Gmail, Calendar, Slack and hundreds of other apps through Composio, or you can hook up your own MCP server. It reads your actual apps, not just local files.

Desktop & browser control - can click around macOS apps (via cua-driver) and drive a browser through an embedded Chrome bridge. Real element-level clicking, not screenshot guessing.

Real deliverables - can export .docx/.xlsx/.pdf files, spin up a small web app on a localhost URL, that kind of thing. Actual files you can use, not just text in a chat.

Files, shell, web research - can edit files, run local commands, and look stuff up online.

Skills library + auto-updates - if a workflow works well once, you can save it and reuse it later. It also updates itself between releases so you don't have to.

On-demand and scheduled jobs already work. For the rest, check the [roadmap](docs/ROADMAP.md).

## How it's built

Desktop: Tauri + React - the window you look at
Local engine: Rust (Axum) sidecar - runs the agent on your machine
Cloud: Rust (Axum) + Better Auth + Postgres - sign-in, usage, managed model routing

[Architecture](docs/ARCHITECTURE.md) · [Auth](docs/AUTH.md) · [Cloud](docs/CLOUD.md) · [Releases](docs/RELEASES.md) · [Contributing](CONTRIBUTING.md)

---

v0.5.x · install · sign in · finish a job · update

[Releases](https://github.com/Ryz3nPlayZ/zWork/releases) · [Issues](https://github.com/Ryz3nPlayZ/zWork/issues) · [Discussions](https://github.com/Ryz3nPlayZ/zWork/discussions)
