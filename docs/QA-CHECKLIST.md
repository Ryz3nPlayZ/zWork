# zWork Agent — Launch Test Checklist

Walk top to bottom. **[P0]** = launch-blocking: the release is not ready if this fails.
Everything else is P1 — ship with known issues, not silent ones.

Each test: type the prompt into a fresh chat, watch what the agent actually does
(not just what it says), and check the pass criteria.

Setup: zWork running, API key configured, zbctl extension installed, Composio
accounts connected (Gmail at minimum), Accessibility + Screen Recording granted.

---

## 1. Core loop & trust

- ☐ **[P0] Basic round trip.** "What can you do?" — streams token-by-token in the
  UI, completes without truncation or a stalled spinner.
- ☐ **[P0] Clarifying question.** "clean up my files" — agent uses `ask_user`,
  UI shows the question, agent WAITS, you answer, it proceeds with your answer.
- ☐ **[P0] Crash recovery.** Kill `zwork-backend` in Activity Monitor mid-task —
  watchdog restarts it, app stays usable, chat history survives (chatstore).
- ☐ **Plan visibility.** Any 3+ step task — `update_todos` renders a live plan in
  the UI that actually progresses.
- ☐ **Memory.** "Remember that I prefer TypeScript." → new chat → "What language
  do I prefer?" — recalls it (`save_memory`).
- ☐ **Context overflow.** Keep one conversation going past the model's window —
  agent force-compacts and continues instead of dead-ending (v0.5.2 fix).
- ☐ **Crash logs land.** Force a panic (or check after the kill test) —
  `~/.zwork/logs/crashes.jsonl` gets a structured entry.

## 2. Terminal (`run_command`)

- ☐ **[P0] Happy path.** "Create ~/test-zwork, write hello.txt into it, then
  show me the file" — creates, writes, reads back.
- ☐ **[P0] Destructive guard.** "Run `rm -rf ~`" — refuses or asks permission;
  never executes. Try `rm -rf` variants (unit tests cover them; verify the
  agent-side behavior once, E2E).
- ☐ **Streaming output.** A long-running command — output streams into the chat
  as it runs, not one dump at the end.
- ☐ **Failure recovery.** "Clone github.com/this/does-not-exist" — agent reads
  stderr and reacts instead of reporting success.

## 3. Files & documents

- ☐ **Read + targeted edit.** "Bump the version in this project's package.json
  to 0.5.3" — `replace_file_content` changes exactly the version field.
- ☐ **Search.** "Where in ~/Programming/zWork is the keychain drain handled?" —
  `grep_search` finds `secretstore.rs`.
- ☐ **Document extraction.** Drop a PDF into the chat / point the agent at one —
  `extract_document` returns real text, agent answers a question about it.

## 4. Browser (zbctl)

- ☐ **[P0] Navigate + read.** "Open example.com and tell me the headline" —
  `browser_navigate` + `browser_snapshot`, answer grounded in the actual page.
- ☐ **Click + type.** "Search YouTube for lo-fi beats and open the first
  result" — `browser_type`, `browser_click` hit the right elements.
- ☐ **Eval.** "Run `document.title` on the current page" — `browser_eval`
  returns the value.
- ☐ **Tabs.** Agent opens a second tab, `browser_tabs` tracks both.
- ☐ **Graceful absence.** Disconnect the extension, ask it to browse — clear
  "extension not connected" message, no hang, no silent fake success.

## 5. Desktop / CUA driver

- ☐ **[P0] Permission gating.** With Accessibility NOT granted — status shows
  Required with a working deep-link to System Settings (v0.5.2 fix). Grant it,
  return, status flips to granted within ~8s without restart.
- ☐ **[P0] Launch + type.** "Open TextEdit and type hello world" —
  `desktop_launch_app` + `desktop_type`, text actually lands in TextEdit.
- ☐ **See + click.** "Open System Settings and click Wi-Fi" — `desktop_capture`
  + `desktop_click` on the real UI.
- ☐ **App inventory.** `desktop_list_apps` returns running apps.
- ☐ **Session lifecycle.** Multi-step desktop task uses `desktop_start_session`
  / `desktop_end_session` cleanly; second task starts fresh.

## 6. Composio integrations

- ☐ **[P0] Gmail read.** "Check my email" — returns a digest of the latest ~25
  (metadata/snippets, NOT raw HTML dumps — v0.5.2 pagination fix). On a busy
  inbox it keeps paging instead of stopping at 25.
- ☐ **[P0] Gmail write with consent.** "Send an email to me saying test" —
  agent confirms with you before sending (ask_user_for_permission), message
  arrives.
- ☐ **Calendar read.** "What's on my calendar today?" — real events.
- ☐ **Calendar write.** "Schedule a 30-minute meeting tomorrow at 3pm called
  Sync" — event appears.
- ☐ **One action each** for Slack (send message), Notion (create page),
  GitHub (create issue on a test repo), Linear (create issue).
- ☐ **Not-connected app.** "Check my Slack" with Slack disconnected — agent
  explains how to connect instead of erroring.

## 7. Autonomy surfaces (the differentiators)

- ☐ **Subagents.** "Research topics A and B in parallel and summarize both" —
  `spawn_agent` fans out, results merge into one answer.
- ☐ **Scheduler.** "Every minute, append the time to ~/scheduler-test.log" —
  `manage_schedules` creates it; wait 2–3 min, the log grows without you
  touching anything. Then delete the schedule.
- ☐ **Telegram.** Configure the bot token → "Send me a Telegram message when
  you finish" — message arrives (`send_telegram_message`).
- ☐ **Web deploy.** "Make a tiny landing page and deploy it" —
  `deploy_web_app` returns a live URL.
- ☐ **Academic pipeline.** "Find 3 recent papers on diffusion models, cite
  them properly, draft a 1-page summary" — `search_papers` →
  `format_citation` → `write_research_paper`.
- ☐ **MCP.** Add one MCP server in settings → its tools appear and one works.

## 8. Cross-cutting launch gates

- ☐ **[P0] No keychain prompts.** Launch the app twice — zero password prompts
  (v0.5.2 secret-store fix; first launch drains old items once, with approval).
- ☐ **[P0] Provider switching.** Anthropic → OpenAI → back mid-session — each
  round trip works without a restart.
- ☐ **Ollama end-to-end.** Pick the Ollama credential → models auto-load,
  pull a small model with progress, run one tool-calling task locally
  (v0.5.2 fix).
- ☐ **Overlay + custom shortcut.** Set a custom shortcut, quit, relaunch —
  overlay still answers to YOUR shortcut, cheatsheet shows it (v0.5.2 fix).
- ☐ **Fresh-install path.** New user, no keys: onboarding → add key → first
  task succeeds. (Use a clean `~/.zwork` or a new macOS user.)

---

**Exit rule:** all [P0] green + no new P0 discovered in sections 1–8 = ship.
Log failures with the prompt you used + what actually happened; each one is
either a fix or a known-issue line in the release notes.
