# zWork on Windows

What has actually been run on Windows, and what is still assumed. Keep this
up to date when Windows-specific code changes.

Everything under "Verified" runs on GitHub's `windows-latest` runner in CI
(`.github/workflows/ci.yml`, jobs `sidecar-windows` and `tauri-windows`) on
every push to `main` and `site/redesign`. No real Windows PC or VM has been
used so far.

## Verified on Windows (CI)

- **Backend builds and every backend test passes**: `cargo check --all-targets`
  and `cargo test` in `sidecar-rust`. A few tests that spell out Unix paths
  (`/tmp`, `/Desktop/...`) only run on macOS and Linux.
- **Desktop app compiles**: `cargo check` for `app/src-tauri`, with the front
  end built first. It is not bundled or launched.
- **Desktop control against the real driver** (cua-driver-rs, the version the
  release bundles) and **the managed Python/Node install from scratch**.
- **Backend smoke test** (`scripts/windows-smoke/smoke.py`). It starts the real
  backend, with no console window, from a home folder whose path contains
  spaces, and uses a fake model server so no API key is needed. It checks:
  - a long task: the model runs a PowerShell command that prints 30,000
    lines, then streams a 4,000-piece reply. The whole reply arrives and is
    saved, and status updates stay throttled;
  - no PowerShell is left running after the command finishes;
  - a connector (stdio MCP) connects, and removing it stops its process,
    even one that ignores its closed input;
  - no half-written save files are left behind;
  - after the backend is killed, it starts again on the same port and the
    chat is still there;
  - Send logs returns a code, includes the log files, and leaves out the
    access token and the home folder path.

  Its output (event stream, backend log, results) is kept as the
  `windows-smoke` artifact on each CI run.

## Fixed for Windows, in code (covered by the checks above where noted)

- **Long answers lost their ending.** The backend saved the whole chat file
  after every streamed word. On the Windows runner it fell about 13 seconds
  behind, and the turn closed before the rest arrived: the last third of a
  4,000-part reply was missing, both on screen and in the saved chat, with no
  error. It now saves a few times a second and once at the end of the reply.
  Covered by the smoke test, which this bug failed. It wasn't Windows-only:
  a slow enough disk anywhere would hit it.

- Removing a connector, or quitting zWork, now stops the whole process tree
  (`taskkill /T`), not just the direct child. zWork also waits for taskkill to
  finish: if it doesn't wait, `cmd` dies first and the program under it is
  left running. That earlier version failed the connector check on Windows.
- Chats, tasks, schedules and inbox are saved through one helper
  (`paths::replace_file`). It retries briefly when antivirus or the search
  indexer holds the file. Concurrent saves are tested; the antivirus case
  itself is not reproduced in CI.
- No console windows flash when zWork looks up tools (`where`) or checks
  for a GPU (`nvidia-smi`).
- "Ask before changes" read `\` in PowerShell paths as an escape character, so
  it asked about files zWork writes into its own folders. It also asked
  about output thrown away with `2>/dev/null`, `$null` or `NUL`. Covered by
  the backend tests.
- A connector whose program is missing (for example `npx` with no Node.js)
  now says what to install, instead of showing cmd's "not recognized" error.

## Not verified on Windows (assumed)

- **The full desktop app running**: the window, WebView2, the installer, auto
  update, and the tray. Nothing launches the Tauri app on Windows yet.
- **Long chats in the app window**: the streaming and rendering fixes for long
  chats are front-end code, the same on every platform. They have only been
  run in macOS's WebKit, never in WebView2.
- **The app's backend restart and health check**: the logic is unit-tested on
  macOS and Linux. Its Windows timeout handling and the tree kill on quit
  compile on Windows but have not been run there.
- **Connector arguments with spaces or quotes** going through `cmd /C`.
  Commands are bare names found on PATH, so this is judged low risk.
- **Real antivirus or indexer locks** on save, and **user names with
  non-ASCII characters**.
