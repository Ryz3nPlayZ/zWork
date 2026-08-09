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

- **Compare three vacuum cleaners** → you get a side-by-side comparison sheet. Not a lecture about "features and reviews."
- **Yesterday's meeting notes** → a follow-up email draft you can actually send.
- **Your Downloads folder is a mess** → it sorts it into subfolders while you watch.

So instead of advice, you get the result. That's the idea, anyway.

## Install

<div align="center">

<table>
<tr>
<td align="center" width="33%">
<b>macOS</b><br>
<sub>Intel &amp; Apple Silicon</sub><br><br>
<a href="https://github.com/Ryz3nPlayZ/zWork/releases/latest">Download .dmg</a>
</td>
<td align="center" width="33%">
<b>Windows</b><br>
<sub>x86_64</sub><br><br>
<a href="https://github.com/Ryz3nPlayZ/zWork/releases/latest">Download .exe</a>
</td>
<td align="center" width="33%">
<b>Linux</b><br>
<sub>AppImage, x86_64</sub><br><br>
<a href="https://github.com/Ryz3nPlayZ/zWork/releases/latest">Download .AppImage</a>
</td>
</tr>
</table>

</div>

Or via command line:

#### macOS (Homebrew)
```bash
brew tap ryz3nplayz/zwork https://github.com/Ryz3nPlayZ/zWork
brew install --cask zwork
```

#### Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/Ryz3nPlayZ/zWork/main/scripts/install-windows.ps1 | iex
```

#### Linux (bash)
```bash
curl -fsSL https://raw.githubusercontent.com/Ryz3nPlayZ/zWork/main/scripts/install.sh | bash
```

Open it, sign in, and ask for something. No prompt engineering required.

#### Run from source
```bash
./run.sh
```
That builds the Rust sidecar, installs frontend deps, and opens the desktop app in dev mode.

## Stuff that works today

**Scheduled agents.** You set up a recurring job (daily digest, inbox sweep, checking a site) and it runs on its own and emails you the results. You can walk away, nobody has to watch it.

**App integrations (Composio + MCP).** It can reach into Gmail, Calendar, Slack and hundreds of other apps through Composio, or you can hook up your own MCP server. It reads your actual apps, not just local files.

**Desktop & browser control.** It can click around macOS apps (via cua-driver) and drive a browser through an embedded Chrome bridge. Real element-level clicking, not screenshot guessing.

**Real deliverables.** It can export `.docx`/`.xlsx`/`.pdf` files, spin up a small web app on a localhost URL, that kind of thing. Actual files you can use, not just text in a chat.

**Files, shell, web research.** It can edit files, run local commands, and look stuff up online.

**Skills library + auto-updates.** If a workflow works well once, you can save it and reuse it later. It also updates itself between releases so you don't have to.

On-demand and scheduled jobs already work. As for the rest, I'm too lazy to rewrite this section, so just go check the [roadmap](docs/ROADMAP.md).

## How it's built

| Layer | Stack | What it does |
|---|---|---|
| **Desktop** | Tauri + React | The window you look at |
| **Local engine** | Rust (Axum) sidecar | Runs the agent on your machine |
| **Cloud** | Rust (Axum) + Better Auth + Postgres | Sign-in, usage, managed model routing |

[Architecture](docs/ARCHITECTURE.md) &nbsp;·&nbsp; [Auth](docs/AUTH.md) &nbsp;·&nbsp; [Cloud](docs/CLOUD.md) &nbsp;·&nbsp; [Releases](docs/RELEASES.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

<div align="center">
<sub>

**v0.5.x** &nbsp;·&nbsp; the bar before anything new ships:<br>
install · sign in · finish a real job · update

[Releases](https://github.com/Ryz3nPlayZ/zWork/releases) &nbsp;·&nbsp; [Issues](https://github.com/Ryz3nPlayZ/zWork/issues) &nbsp;·&nbsp; [Discussions](https://github.com/Ryz3nPlayZ/zWork/discussions)

</sub>
</div>
