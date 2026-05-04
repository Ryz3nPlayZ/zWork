<div align="center">

<img src="app/public/zwork.svg" alt="zWork" width="88" height="88">

# zWork

**A desktop AI assistant that does jobs, not just answers questions.**

[![Release](https://img.shields.io/github/v/release/Ryz3nPlayZ/zWork?style=flat-square&color=171716&labelColor=2a2a2a)](https://github.com/Ryz3nPlayZ/zWork/releases)
[![Platforms](https://img.shields.io/badge/runs%20on-macOS%20%7C%20Windows%20%7C%20Linux-171716?style=flat-square&labelColor=2a2a2a)](#install)
[![License](https://img.shields.io/github/license/Ryz3nPlayZ/zWork?style=flat-square&color=171716&labelColor=2a2a2a)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Ryz3nPlayZ/zWork?style=flat-square&color=171716&labelColor=2a2a2a)](https://github.com/Ryz3nPlayZ/zWork/stargazers)

[**Download**](https://github.com/Ryz3nPlayZ/zWork/releases/latest) &nbsp;·&nbsp; [Docs](docs/WIKI.md) &nbsp;·&nbsp; [Roadmap](ROADMAP.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

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

**Chat that streams**

Watch answers and activity appear live, as the agent works.

</td>
<td width="50%" valign="top">

**Files and folders**

zWork can read, write, and reorganise things on your computer.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Local commands**

Runs shell tasks on your machine when a job needs them.

</td>
<td width="50%" valign="top">

**Web research**

Pulls in current sources from the open web.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Skills library**

Save what works once, reuse it any time.

</td>
<td width="50%" valign="top">

**Auto-updates**

The app updates itself between releases.

</td>
</tr>
</table>

---

## What's next

The next version turns chat into a workspace. The output of a job — a document, a spreadsheet, a chart, a small to-do list — sits next to the conversation that produced it, where you can edit and keep it.

See the [roadmap](ROADMAP.md) for the order of work.

---

## How it's built

| Layer | Stack | What it does |
|---|---|---|
| **Desktop** | Tauri + React | The window you look at |
| **Local engine** | Python + FastAPI sidecar | Runs the agent on your machine |
| **Cloud** | Rust (Axum) + Better Auth + Postgres | Sign-in, usage, managed model routing |

[Architecture](docs/ARCHITECTURE.md) &nbsp;·&nbsp; [Auth](docs/AUTH.md) &nbsp;·&nbsp; [Cloud](docs/CLOUD.md) &nbsp;·&nbsp; [Releases](docs/RELEASES.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

### Run from source

```bash
./run.sh
```

That bootstraps the Python sidecar, installs frontend deps, and opens the desktop app in dev mode.

---

<div align="center">
<sub>

**v0.3.x** &nbsp;·&nbsp; the bar before anything new ships:<br>
install · sign in · finish a real job · update

[Releases](https://github.com/Ryz3nPlayZ/zWork/releases) &nbsp;·&nbsp; [Issues](https://github.com/Ryz3nPlayZ/zWork/issues) &nbsp;·&nbsp; [Discussions](https://github.com/Ryz3nPlayZ/zWork/discussions)

</sub>
</div>
