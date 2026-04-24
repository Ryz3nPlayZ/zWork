# zWork

Your AI assistant that lives on your desktop and actually gets things done.

zWork is a desktop app that works like a chat — but instead of just answering questions, it can take action on your computer. Organize files, research topics, fill out forms, create documents, and handle the repetitive stuff you don't want to.

Just describe what you need. zWork figures out the rest.

![made-with-tauri](https://img.shields.io/badge/built%20with-Tauri%202-black?style=flat-square)
![made-with-fastapi](https://img.shields.io/badge/backend-FastAPI-black?style=flat-square)
![made-with-react](https://img.shields.io/badge/frontend-React%20%2B%20TS-black?style=flat-square)

## What it can do

- **Chat naturally** — tell it what you need in plain language
- **Work with your files** — read, write, move, rename, and organize
- **Create documents** — reports, spreadsheets, summaries, and more
- **Browse the web** — research, compare, extract, and summarize
- **Run commands** — automate tasks you'd normally type out
- **Remember context** — picks up where you left off across sessions
- **Use skills** — built-in abilities for specialized tasks like document creation and data work

## Install

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Ryz3nPlayZ/zWork/main/scripts/install.sh | bash
```

### macOS

Download the latest `.dmg` from [GitHub Releases](https://github.com/Ryz3nPlayZ/zWork/releases), open it, and drag zWork to your Applications folder.

## Example tasks

> "Rename all these files based on what's inside them."

> "Summarize these tabs into a one-page brief and save it."

> "Extract the tracking numbers from this page and put them in a spreadsheet."

> "Draft a follow-up email based on these meeting notes."

> "Organize my Downloads folder by file type."

## Your data stays yours

zWork runs locally on your machine. Your chats, files, and settings live on your computer — not in someone else's cloud.

## Development

If you're building from source:

```bash
./run.sh
```

This sets everything up and opens the desktop app. See [docs/RELEASES.md](docs/RELEASES.md) for build and packaging details.

## Credits

zWork is built with [Tauri](https://tauri.app), [FastAPI](https://fastapi.tiangolo.com), [React](https://react.dev), [Three.js](https://threejs.org), and [Anthropic Skills](https://github.com/anthropics/skills).
