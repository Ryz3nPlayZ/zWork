# zWork 0.3.18-beta.6 Release Checklist

## Scope

- [x] Keep frontend/design unchanged. This pass only touches backend harness, Tauri backend lifecycle, API client readiness logic, tests, and release docs.
- [x] Preserve existing dirty local work; do not revert unrelated modified files.
- [x] Ship DeepSeek V4 Flash as the managed router target.
- [x] Merge/implement rar-files PR intent from open PR #34 and #43.
- [x] Include already-merged rar-files PR features in release validation.

## rar-files PR Coverage

- [x] #22 Restrict default GitHub token permissions.
- [x] #23 Move Postgres password out of docker-compose env literals.
- [x] #24 Validate Ollama model proxy base URLs against SSRF.
- [x] #25 Percent-decode auth callback without UTF-8 boundary panic.
- [x] #26 Restrict external URL opening to http(s).
- [x] #28 Auth rate limiting.
- [x] #29 `extract_document` tool for PDFs, Office docs, text, and Markdown.
- [x] #30 Slash command templates.
- [x] #31 MLX detection.
- [x] #32 Anthropic prompt caching and Claude 4 max token updates.
- [x] #33 Provider presets including DeepSeek.
- [x] #35 Stale file cleanup.
- [x] #36 README/release docs refresh.
- [x] #37 Updater GitHub Releases fallback.
- [x] #38 Retry OpenAI-compatible 429s.
- [x] #39 Attachment chips.
- [x] #41 Per-model base URL preservation.
- [x] #34 MCP client support implemented: config loader, stdio manager, tool schema registration, tool dispatch, status APIs, tests.
- [x] #43 Harness tier-one support implemented: project context injection, plan mode read-only tool catalog, destructive command gate, chat compaction, tests.

## Issue Fixes

- [x] Recent news/current-event requests now have a backend `web_search` tool, so the agent can answer in chat without opening browser tabs through `dctl`.
- [x] System prompt now tells the agent to use `web_search` for recent/current factual lookup and reserve `dctl browser` for explicit browser-control tasks.
- [x] Backend self-kill commands targeting port `8787` are classified destructive and rejected directly by `run_command`, including `lsof -ti:8787 | xargs kill -9`.
- [x] Destructive shell commands are permission-gated when `auto_approve_destructive` is false.
- [x] Onboarding/backend readiness is hardened: Tauri exposes `ensure_backend` and `restart_backend`, and the API client waits longer and restarts the sidecar once if health checks keep failing.
- [x] Chat streams persist partial assistant content and activities during streaming through the existing run context path.
- [x] MCP startup failures are non-fatal and exposed through `/api/mcp/servers`.

## Release Verification

- [x] `python3 -m pytest` passes: 127 passed.
- [x] `npm run build` passes.
- [x] `cargo check --manifest-path app/src-tauri/Cargo.toml` passes with existing `tauri_plugin_shell::open` deprecation warnings.
- [x] `cargo test --manifest-path app/src-tauri/Cargo.toml` passes: 12 passed, with the same existing deprecation warnings.
- [ ] Run a packaged desktop smoke test: sign in, finish onboarding immediately, confirm no "local backend is not ready" error.
- [ ] In the packaged app, ask "search for some recent news events" and confirm it returns summarized events in chat without opening Chrome.
- [ ] Confirm a destructive command request is blocked unless approved.
- [ ] Confirm `/api/mcp/servers` and `/api/mcp/tools` return usable JSON with no MCP config and with a sample local MCP server.
- [ ] Confirm managed mode routes through DeepSeek V4 Flash in production.
- [ ] Build signed release artifacts with `scripts/package-release.sh <platform>` after `npm run tauri build` completes on each target platform.
- [ ] Publish GitHub release assets plus `latest.json` and signatures.
- [ ] Verify updater install path from the previous beta to `0.3.18-beta.6`.

## Notes

- The worktree still contains unrelated pre-existing modifications and untracked files. Review `git status --short` before committing.
- `app/src/lib/api.ts` changed readiness behavior only; no frontend component layout, CSS, or design was changed in this pass.
