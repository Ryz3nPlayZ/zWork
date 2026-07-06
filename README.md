<div align="center">

<img src="app/public/zwork.svg" alt="zWork" width="88" height="88">

# zWork

**A desktop AI agent that runs on your schedule and works across your apps — not just another chat box.**

[![Release](https://img.shields.io/github/v/release/Ryz3nPlayZ/zWork?style=flat-square&color=171716&labelColor=2a2a2a)](https://github.com/Ryz3nPlayZ/zWork/releases)
[![Platforms](https://img.shields.io/badge/runs%20on-macOS%20%7C%20Windows%20%7C%20Linux-171716?style=flat-square&labelColor=2a2a2a)](#install)
[![License](https://img.shields.io/github/license/Ryz3nPlayZ/zWork?style=flat-square&color=171716&labelColor=2a2a2a)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Ryz3nPlayZ/zWork?style=flat-square&color=171716&labelColor=2a2a2a)](https://github.com/Ryz3nPlayZ/zWork/stargazers)

[**Download**](https://github.com/Ryz3nPlayZ/zWork/releases/latest) &nbsp;·&nbsp; [Docs](docs/WIKI.md) &nbsp;·&nbsp; [Roadmap](docs/ROADMAP.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

</div>

---

## What it does

Tell zWork what you want done. It does it.

<table>
<tr>
<td width="33%" valign="top">

**Compare three vacuum cleaners**

You get a side-by-side sheet — not a paragraph telling you to "consider features and reviews."

</td>
<td width="33%" valign="top">

**Turn yesterday's notes into a follow-up email**

You get a real draft, not advice on how to write one.

</td>
<td width="33%" valign="top">

**Clean up your downloads folder**

It moves the files. You watch it happen.

</td>
</tr>
</table>

zWork is for people who want the thing done, not another app to master.

---

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

Open it, sign in, ask for something.

---

## What works today

<table>
<tr>
<td width="50%" valign="top">

**Scheduled agents**

Set a recurring job — daily digest, inbox sweep, monitor a site — and zWork runs it on its own schedule, posting results to your inbox. No one watching, no chat window open.

</td>
<td width="50%" valign="top">

**App integrations (Composio + MCP)**

Connect Gmail, Calendar, Slack, and hundreds more via Composio, or plug in any MCP server. The agent can read and act on your actual apps, not just files.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Desktop & browser control**

Drive macOS apps (capture, click, type) via cua-driver and automate the browser through an embedded Chrome bridge — element-level, not screenshots-and-pray.

</td>
<td width="50%" valign="top">

**Real deliverables**

Generate and export `.docx`/`.xlsx`/`.pdf`, deploy a local web app to a live URL, and produce structured documents — not just text in a chat.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Files, shell, web research**

Read/write/reorganise files, run local commands, and pull live sources from the web.

</td>
<td width="50%" valign="top">

**Skills library + auto-updates**

Save what works once, reuse it any time. The app updates itself between releases.

</td>
</tr>
</table>

---

## What's next

zWork already runs jobs on demand and on a schedule. The next version turns the output of those jobs into a persistent workspace — a document, a spreadsheet, a chart, a to-do list — that sits next to the conversation that produced it, where you can edit and keep it.

See the [roadmap](docs/ROADMAP.md) for the order of work.

---

## How it's built

| Layer | Stack | What it does |
|---|---|---|
| **Desktop** | Tauri + React | The window you look at |
| **Local engine** | Rust (Axum) sidecar | Runs the agent on your machine |
| **Cloud** | Rust (Axum) + Better Auth + Postgres | Sign-in, usage, managed model routing |

[Architecture](docs/ARCHITECTURE.md) &nbsp;·&nbsp; [Auth](docs/AUTH.md) &nbsp;·&nbsp; [Cloud](docs/CLOUD.md) &nbsp;·&nbsp; [Releases](docs/RELEASES.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

### Run from source

```bash
./run.sh
```

That builds the Rust sidecar, installs frontend deps, and opens the desktop app in dev mode.

---

<div align="center">
<sub>

**v0.5.x** &nbsp;·&nbsp; the bar before anything new ships:<br>
install · sign in · finish a real job · update

[Releases](https://github.com/Ryz3nPlayZ/zWork/releases) &nbsp;·&nbsp; [Issues](https://github.com/Ryz3nPlayZ/zWork/issues) &nbsp;·&nbsp; [Discussions](https://github.com/Ryz3nPlayZ/zWork/discussions)

</sub>
</div>
