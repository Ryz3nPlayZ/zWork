# zWork tool audit: what the model is offered, what breaks, what it costs

Date: 2026-11-16. Branch `site/redesign` at `66636d9`. Report only; no source was changed.

**How this was measured.**
- The tool lists come from captured wire requests. A scratch sidecar ran against a mock OpenAI-compatible endpoint (scratch `ZWORK_HOME`, sidecar on port 8799, mock on 8796) under four scenarios: product, plan, coding-only, and a specialist-keyword message. The bodies of `tools[]` were recorded exactly as sent.
- Token counts are **chars/4** of each tool's compact JSON wire form (`{"type":"function","function":{name,description,parameters},"strict":false}`). tiktoken is not installed.
- Cross-check: on GLM 5.3 the first bench step reads 5,888 cached tokens. The chars/4 estimate of the tool block is ~6,031. GLM renders tools first, so this cached span is the tool block.
- Probes: a scripted mock called a dozen tools with good, bad and unknown arguments, so the exact text the model gets back is recorded here.
- Run evidence: bench `bench/lite/runs/20261116-*` and the local app log `~/Library/Application Support/zWork/state/logs/agent.jsonl`. Only aggregates are used; no message content.

**Headline cost.** A typical product turn offers **39 tools = 24,124 chars ≈ 6,031 tokens**. The specialist keywords push this to **50 tools ≈ 7,214**. Gmail through Composio adds about **2.2–2.9k** more. The system prompt is another ≈ 7,015 tokens on the dev machine (≈ 5.4k for a typical user; see M10). In the bench, that fixed prefix of ≈ 12.5k tokens is **~81% of all prompt tokens**, and tool schemas alone are **~40%**. The model used **9 of the 39 tools**.

---

## 1. Ranked findings

Severity order: Broken (B), then Misleading (M), then Strict-schema risks (S), then Redundant (R), then Cost (C). Within each group the items are ordered by user impact.

### Broken: does not work, or does damage when used

**B1. `browser_screenshot` puts a ~300k-character base64 PNG into the context as text.**
- **The chain:**
  - The schema says "Returns base64-encoded PNG" (`sidecar-rust/src/tools/mod.rs:564-567`).
  - The executor (`tools/mod.rs:943`) calls `zbctl::screenshot` (`sidecar-rust/src/zbctl.rs:75`), then `browser_bridge::send_command` (`sidecar-rust/src/browser_bridge.rs:55`).
  - The extension returns `{dataUrl}` from `chrome.tabs.captureVisibleTab(..., {format:"png"})` (`app/src-tauri/extension/background.js:54`).
  - `NativeTool` hands the raw string back as a text block (`sidecar-rust/src/agent/harness_turn.rs:375`).
- **Real use:** 8 calls in the local log. Each result was **308k–356k chars, roughly 80–90k tokens**, so one call costs about 13× the whole tool list. Two chats repeated the identical call 4 times, because the model cannot see a picture in a wall of base64.
- **The `/api` screenshot endpoint already decodes the same payload correctly** (`sidecar-rust/src/server.rs:2172-2200`).
- **Fix:**
  - Decode the `dataUrl` and return an image content block when the model accepts images, as `read` already does (`sidecar-rust/src/harness/tools/read.rs:151-164`). Downscale and send it as JPEG.
  - For text-only models, return "Screenshot saved to <path>; this model can't view images, use browser_snapshot".
  - Either way, never return base64 as text.

**B2. Results from zWork's own tools are never truncated.**
- `NativeTool::run` passes every result through whole (`harness_turn.rs:278-380`, return at `:375`).
- The pi core tools truncate (`sidecar-rust/src/harness/tools/truncate.rs`), and Composio results are capped at 8,000 chars (`sidecar-rust/src/connectors/composio.rs:589`). The ~40 zWork tools have no cap.
- **Real use:**

  | Tool | Result size |
  |---|---|
  | `desktop_list_apps` | 40,871 chars |
  | `read_skill` | up to 63,746 chars |
  | each `browser_click` | ~9.7k chars (it returns a fresh page snapshot) |
  | `browser_screenshot` | see B1 |

- **Fix:** run every `NativeTool` text result through the same truncate-or-spill helper the core tools use: head plus tail, and spill the full text to a file with its path in the note. Give `read_skill` a larger cap, or have it list sections and load on demand.

**B3. `read` on a PDF, Word or Excel file returns raw bytes.**
- Anything that isn't an image goes through `String::from_utf8_lossy` (`harness/tools/read.rs:166`). The probe `read sample.pdf` returned the raw `%PDF-…` stream.
- The system prompt tells the model to use `extract_document` for these files (`sidecar-rust/src/settings.rs:594`, `:735`). But `read` gives no hint when the model reaches for it first, which is the natural first move.
- **Fix:** sniff the magic bytes (`%PDF`, a `PK` zip holding `word/`, `xl/` or `ppt/`, OLE `D0CF11E0`). Then either delegate to `extract_document`, or return an error: "This is a PDF. Use extract_document(path) to read its text."

**B4. `browser_eval` failed 8 of 8 times in real use (page CSP).**
- Schema at `tools/mod.rs:541`, executor at `:934`. `zbctl.rs` rewrites the CSP error to make it clearer, but the call still fails.
- The connected-status line still tells the model to use it for "ANY task involving a website" (`harness_turn.rs:1788`).
- **Fix:** leave `browser_eval` out of the default browser set and out of that status line. If it is needed, run the script through the extension in a world that page CSP does not block, and offer it only once that works.

**B5. The 11 desktop-control tools are offered on every Mac, even with no permissions.**
- `driver_available()` is `cfg!(target_os = "macos") || …` (`sidecar-rust/src/cua/mod.rs:46-48`), so it is always true on macOS and never checks Accessibility or Screen Recording.
- The comment at `tools/mod.rs:355-357` ("Advertised only where the driver exists … burn turn after turn retrying") describes the failure that still happens.
- **Real use:** `desktop_capture` failed 3 of 3 times, each with an empty accessibility tree.
- **Cost:** ≈ 1,391 tokens on every call.
- **Fix:** gate on the cached permission status. The Settings poll already reads it without launching the daemon. When permissions are missing, offer none of the tools and add one plain line to the turn context: "Desktop control is off: zWork doesn't have Accessibility permission. Tell the user to allow it in Settings → Permissions."

**B6. The 8 browser tools are offered while Chrome is disconnected, and the model gets three different instructions.**
- `extension_connected()` is already checked each turn (`harness_turn.rs:1784`), but the tools are offered anyway (`tools/mod.rs:497-573`).
- What the model is told:
  - The status line says "tell the user to connect it rather than guessing" (`harness_turn.rs:1790`).
  - The "Controlling apps" rules say "If a `browser_*` call says no extension is connected, use `desktop_*` for the rest of the task" (`settings.rs:699`).
  - The tool error says "please tell the user to open Chrome with the **zbctl** extension enabled" (`browser_bridge.rs:65`).
- "zbctl" is an internal name that a non-technical user cannot act on.
- **Fix:**
  - Don't offer the browser tools when the bridge is down (saves ≈ 735 tokens). Decide this at turn start and keep it for the rest of the chat; see section 5.
  - Pick one rule and say it in plain words: "the zWork extension in Chrome".

**B7. A gated-out tool or a misspelled tool gets a bare "unavailable".**
- The runtime replies `Tool "x" is unavailable` (`sidecar-rust/src/harness/runtime/tool_exec.rs:271`). It gives no reason and lists no valid names.
- Specialist tools come and go with keywords in the *latest* message (`tools/mod.rs:151-158`, applied at `harness_turn.rs:1720` and `:1863`). The code comment admits that "now do the same again" loses them (`tools/mod.rs:149-150`).
- The probe got the same bare reply for `send_telegram_message`, `deploy_web_app` and `format_citation`, all of which are valid zWork tools.
- **Fix:**
  - Make gated groups sticky for the chat (section 5).
  - For a known-but-not-loaded tool, say so: "send_telegram_message isn't loaded in this chat; ask the user to turn on …".
  - For an unknown name, list the 3 closest offered names.

**B8. Plan mode still offers Composio *write* actions.**
- `schemas.extend(composio_schemas)` runs whether or not plan mode is on (`harness_turn.rs:1863`).
- MCP tools in plan mode are filtered to read-only ones (`:1882-1886`). Composio has the same check available (`connectors::composio::is_read_only_action`, used in `tools/mod.rs:67-70`) but it is not applied.
- The plan-mode prompt says only read-only tools are available (`settings.rs:554`).
- With Gmail connected, `GMAIL_SEND_EMAIL` is offered while planning. It still goes through the permission gate, unless auto-approve is on.
- **Fix:** in plan mode, keep only the Composio tools for which `is_read_only_action` is true.

### Misleading: the description doesn't match what the tool does

**M1. `spawn_agent`.**
- It says "Returns a task ID to track progress" (`tools/mod.rs:575`). In fact it blocks and returns the sub-agent's full answer (`tools/mod.rs:949-961`).
- It exposes `model_id` ("Optional model override"), which invites the model to make up model ids. The fallback is the settings default, or the hard-coded `"deepseek-flash"` (`:956`), not the model the chat is using.
- The sub-agent's turn cap is 40 (`harness_turn.rs:2062-2067`), but its doc comment still says "same 12-turn cap" (`:2121`).
- **Fix:**
  - Description: "Hand a self-contained task to a helper agent; waits and returns its answer. Use for independent research, not for steps that need the user."
  - Drop `model_id` and use the chat's model.
  - Fix the comment.

**M2. `deploy_web_app` says it returns a "public URL".**
- The description says "public URL" (`tools/mod.rs:344`). The permission prompt the user sees says "Publish a web app to the internet" (`tools/mod.rs:66`).
- It actually starts `npm run dev` or `python -m http.server` on 127.0.0.1 and returns `http://localhost:PORT` (`sidecar-rust/src/deploy.rs:5`, `:116-121`).
- A user told "it's live" could share a link that only works on their own computer.
- **Fix:** rename it to `preview_web_app` and say "Start a local preview that only this computer can open". Fix the permission text to match.

**M3. `browser_navigate` claims "No login walls" and ignores a parameter it reads.**
- The description promises "No login walls" (`tools/mod.rs:498`), and so does the status line (`harness_turn.rs:1788`). This is a promise the tool can't keep.
- The executor reads `tab_id` (`tools/mod.rs:918`), but `tab_id` is not in the schema, so the model can never target a tab. `browser_tabs` lists tabs, but no tool switches to one.
- **Fix:** reword the description. Either add `tab_id` (integer, optional) to the schema or stop reading it.

**M4. `web_search` silently falls back to news headlines.**
- `query` is not required (`tools/mod.rs:163-171`).
- When Exa fails, the code falls back to Google News RSS (`sidecar-rust/src/tools/search.rs:78-88`, `:91-158`). The fallback result carries the same "Results for: q" header and no excerpts, while the description promises "page excerpts".
- **Fix:**
  - Make `query` required.
  - Head the fallback with "Web search is unavailable right now; these are news headlines only (no excerpts)".

**M5. Failures reported as success.**
- `save_memory` accepts any `target` and quietly saves anything unknown to MEMORY.md (`tools/mod.rs:798-800`). The probe sent `target:"bogus"` and got back "Saved to MEMORY.md.".
- Write errors from `save_memory` come back as `Ok` text (`:803`), and so do Telegram send errors (`:811`). The model sees success, and so does the UI's tool tick.
- **Fix:** make `target` an `enum ["memory","user","task"]` and return `Err(...)` on failure.

**M6. The system prompt names tools that aren't offered.**
- "check my email → use `composio__GMAIL_FETCH_EMAILS`", the calendar line and the Drive line are always emitted (`settings.rs:673-681`), even when nothing is connected.
- "All tools below are available every turn" (`settings.rs:339`) is false under specialist gating and in plan mode.
- **Fix:** emit the connector lines only for connected apps. Otherwise say once: "If the user asks about email, calendar or Drive and it isn't connected, tell them to connect it in Settings → Connections."

**M7. `desktop_office` is not a desktop-control tool.**
- It edits .docx and .xlsx files directly, with no GUI (`tools/mod.rs:476-495`). It is offered on every platform, outside the desktop gate.
- Its `type` enum mixes file formats and apps (`word | excel | libreoffice`).
- The prompt's "Making files" rule sends the model to `bash` + python-docx/openpyxl instead (`settings.rs:746-753`). The bench model always took that route.
- **Fix:** pick one route for Office files. Either rename the tool to `office_edit` with `format: docx|xlsx` and load it only when an Office file is involved, or drop it in favour of the python route plus the `docx`/`xlsx` skills.

**M8. The prompt requires two session tools that do nothing for the user's task.**
- `desktop_start_session` and `desktop_end_session` (`tools/mod.rs:465-474`, ≈ 222 tokens, empty schemas) exist to start and stop the driver daemon.
- The prompt orders the model to call them (`settings.rs:696-697`).
- **Fix:** start the session implicitly on the first `desktop_*` call and end it when the turn ends. Delete both tools.

**M9. Per-tool prompt guidance is dead code; a hand-written copy drifts instead.**
- `collect_prompt_contributions` (`sidecar-rust/src/harness/tools/mod.rs:53`) is never called. So each core tool's `prompt_snippet`/`prompt_guidelines` (for example `READ_GUIDELINES`, `read.rs:141`) never reaches the model.
- The system prompt carries its own Tools section instead (≈ 4.8k chars, ≈ 1.2k tokens), which repeats the schemas.
- **Fix:** keep one source. Either wire the contributions in and delete the hand-written list, or delete the dead code.

**M10. The skills list pulls in other AI tools' skill folders, and its 60-item cut can hide skills the prompt asks for.**
- `GLOBAL_DIRS` loads `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`, `~/.pi/…` and `~/.config/opencode/…` (`sidecar-rust/src/skills.rs:29-36`).
- The list is sorted by name and cut at 60 (`skills.rs:68`, `:120-132`).
- On this machine that comes to 95 skills ("…and 35 more"): ≈ 10.2k chars, ≈ 2.6k tokens, mostly developer skills. That rides on every request, including bench runs, which skews them.
- A typical user only has the 21 bundled skills (≈ 3.6k chars, ≈ 0.9k tokens). Five of those are developer skills (`claude-api`, `mcp-builder`, `webapp-testing`, `web-artifacts-builder`, `skill-creator`), which is wrong for this audience.
- Past 60, names late in the alphabet drop off. That includes `xlsx` and `zbctl-browser`, which the prompt tells the model to load.
- **Fix:**
  - Make other agents' folders opt-in.
  - Hide developer bundled skills from the listing.
  - Always list the skills the prompt names.

**M11. Smaller mismatches.**
- The coding-only allowlist comment says it is for "the SWE-bench harness" (`tools/mod.rs:675-680`), but it is the lite bench's `--zwork-coding-only` flag.
- `manage_tasks {}` fails schema validation (`action` is required), although the executor defaults to `list` (`tools/mod.rs:1036`). This is harmless, but schema and code disagree.
- `extract_document` labelled a text PDF as "[Scanned PDF — text below was read with OCR…]" in the probe. The PDF was hand-made, so this is unverified.

### Strict-schema risks

zWork sends every tool with `"strict": false` (`sidecar-rust/src/harness/providers/openai_completions.rs:287-288`; `openai_responses.rs:120`). OpenAI's strict mode is therefore never exercised. The risk is the stricter validators some providers apply anyway. A throwaway checker walked every captured schema.

| Issue | Where | Risk |
|---|---|---|
| `"properties": {}` (empty object) | `browser_screenshot` :564, `browser_tabs` :569, `desktop_list_apps` :449, `desktop_start_session` :465, `desktop_end_session` :470, `detect_hardware` :223 | Some function-calling validators have rejected an OBJECT with no properties (Gemini-style schemas). Not tested here. |
| An object with no `properties` | `format_citation.paper` :188 | Same risk; the model also gets no idea what fields to send |
| `default` keyword | `get_stock_data.range` :231 | Unsupported in strict/structured-output subsets |
| `"required": []` | Composio `known_tool` FETCH_EMAILS, LIST_THREADS, CREATE_EMAIL_DRAFT (`composio.rs:493-585`) | Harmless on most providers. Some validators reject an empty `required` |
| **Raw Composio `input_parameters` passed through unsanitised** | cloud `cloud-src/api/src/main.rs:6262-6340`; sidecar `repair_tool_schemas` (`composio.rs:447-478`) only patches empty parameters | `title`, `examples`, `default`, `nullable` and `anyOf` from the Composio catalogue go straight to the provider. Size and validity are unmeasured. **This is the largest unknown.** |

- No other problems were found: every `required` field exists in `properties`, every array has `items`, and there are no invalid enums.
- **Tests:** `cargo test --release` filtered to the tools/harness modules gave **96 passed, 0 failed, 1 ignored** (live `web_fetch`) out of 341. **No test checks the schemas.**
- **Fix:** add one unit test that walks `get_tool_schemas(false)`, `get_tool_schemas(true)` and every `known_tool`. It should assert: non-empty `properties` (or no `parameters` at all), `required ⊆ properties`, no `default`/`examples`/`title`, every object has properties, and every array has items. Run the same sanitiser over Composio schemas in the cloud before they are served.

### Redundant: tools that overlap and invite the wrong pick

| # | Overlap | Evidence | Suggested fix |
|---|---|---|---|
| R1 | `ask_user` and `ask_question` | Identical schemas (`tools/mod.rs:243`, `:255`) and the same executor (`:963`). `ask_question` reappears whenever a specialist keyword appears ("website", "landing page") | Delete `ask_question`. `ask_user_for_permission` (`:267`) duplicates the permission gate; delete it too |
| R2 | `read`, `extract_document` and `web_fetch` all read documents | `web_fetch` also extracts PDF and Office files; `read` mangles them (B3) | `read` redirects binaries to `extract_document`; make one sentence in each description point to the right tool |
| R3 | Six "planner" tools: `update_todos`, `manage_tasks`, `manage_schedules`, `manage_events`, `post_to_inbox`, plus Composio Google Calendar | `tools/mod.rs:586`, `:609`, `:626`, `:642`, `:660`; ≈ 1,415 tokens together. `manage_events` is a *local* calendar a user will confuse with Google Calendar | Load as one "organiser" group (section 5). Rename `manage_events` to make clear it isn't Google Calendar, or drop it when Calendar is connected |
| R4 | `grep`, `find`, `ls` and `bash` | ≈ 541 tokens for three finders. Bench: `ls` 29, `grep` 3, `find` 1 out of 408 calls | Keep `ls` and `grep`; consider dropping `find` (`bash` and `grep` cover it) |
| R5 | `browser_*` and `desktop_*` can both drive Chrome | Conflicting fallback rules (B6) | Give one rule; only offer what can work |
| R6 | `desktop_office`, `bash` + python, and the docx/xlsx skills | M7 | Choose one route |
| R7 | `post_to_inbox` and `send_telegram_message` | Both notify the user | Keep the inbox; Telegram behind a setting |
| R8 | `desktop_start_session` / `end_session` | M8 | Make them implicit |

**Naming drift.** These raise the error rate on mid-tier models, which copy argument names from neighbouring tools.
- Core tools use camelCase (`ignoreCase`, `oldText`/`newText`); zWork tools use snake_case.
- `element` (desktop) vs `element_id` (browser).
- `app` is required on `desktop_capture` but optional on the other desktop tools.

### Cost

**C1. The fixed prefix dominates prompt spend.**

| Part of the prefix | Size |
|---|---|
| Tools | ≈ 6,031 tokens |
| System prompt | ≈ 7,015 tokens (dev machine; ≈ 5.4k with bundled skills only) |
| Total | ≈ 13k tokens on every model call |

- Bench (GLM 5.3, 5 runs, 322 model steps): 4.95M prompt tokens, 87.2% served from cache.
- Median per-step prompt: 13,776. Mean: 15,370. First-step median: 12,616 (range 12,482–12,796).
- The fixed prefix is **~81% of all prompt tokens**; the tool schemas alone are **~40%**.
- The model used 9 of the 39 tools. The 30 unused tools cost ≈ 3.9k tokens per call.

**C2. The system prompt changes every minute, so each new message in a chat re-pays the whole history uncached.**
- `build_timeline_block` writes `Current time: …` to the minute (`sidecar-rust/src/memory.rs:272`, `:290`). It is substituted into the system prompt (`settings.rs:261`, `:539`, `:716`).
- That contradicts the stated intent at `harness_turn.rs:1794` ("system prompt stays byte-stable for prompt caching").
- The browser status line at the end of the system prompt (`:1784-1793`) changes whenever Chrome connects or disconnects.
- Within one turn the prompt is stable, so step-to-step caching works; the bench first-step cache read of 5,888 is the tool block only. But on every new user message the cache breaks after the tools, and the **entire conversation history is re-billed** at the uncached rate.
- **Fix:** move the time (and the browser status) into the per-turn context attached to the latest user message. That mechanism already exists right below `:1794`. Or keep only the date in the system prompt.

**C3. Keyword gating changes the tool array mid-chat.**
- One keyword adds 11 tools: +4,731 chars, ≈ +1,183 tokens.
- "website" and "landing page" also pull in the academic tools.
- Tools are sorted by name across the whole list (`harness_turn.rs:1890`), so the new names land in the middle of the array. On the next message without a keyword they drop out again. Each flip breaks the cache from the tool block onward, and earlier tool calls in the history can then name tools that no longer exist.

**C4. Composio adds cost on every turn and is fetched from the cloud each time.**
- `all_tool_schemas()`, `connected_apps()` and the apps block are rebuilt every turn (`harness_turn.rs:1726-1729`).
- Gmail alone:

  | Piece | Size |
  |---|---|
  | 7 core schemas | ≈ 5.2k chars, ≈ 1.3k tokens (FETCH_EMAILS 296, FETCH_MESSAGE_BY_MESSAGE_ID 123, FETCH_MESSAGE_BY_THREAD_ID 99, LIST_THREADS 140, SEND_EMAIL 198, REPLY_TO_THREAD 213, CREATE_EMAIL_DRAFT 222) |
  | Connected-apps prompt block (`composio.rs:271-390`) | ≈ 3.5k chars, ≈ 870 tokens |
  | About 16 empty legacy catalogue tools | ≈ 750 tokens |

- The new cloud path (`important=true&limit=200` with raw schemas) is unmeasured and likely larger.
- In September the local log shows **88 tools** offered on one request (20 Gmail + 20 Notion + legacy names).
- Any change in what the cloud returns, including order, also breaks the cache.

**C5. Result bloat outweighs schema cost in real use** (B1, B2). One `browser_screenshot` ≈ 80–90k tokens, which is more than six full turns of tool schemas.

---

## 2. Full tool table

Token counts are chars/4 of the compact wire JSON. Columns:
- **Product**: default product turn (no academic keyword; Chrome bridge on or off makes no difference today; no MCP).
- **Plan**: plan mode.
- **Code**: `ZWORK_CODING_ONLY`.
- **Sub**: sub-agent.
- **Spec.**: added only when the latest message contains a specialist keyword (`tools/mod.rs:151-158`).

| Tool | Purpose (one line) | Chars | ≈Tok | Product | Plan | Code | Sub | Notes |
|---|---|---:|---:|:-:|:-:|:-:|:-:|---|
| **pi core tools** (`sidecar-rust/src/harness/tools/`) | | | | | | | | |
| read | Read a text or image file (offset/limit) | 699 | 174 | ✓ | ✓ | ✓ | ✓ | Raw bytes for PDF/Office (B3) |
| write | Create or overwrite a file | 445 | 111 | ✓ | – | ✓ | ✓¹ | |
| edit | Replace exact text spans in a file | 1,194 | 298 | ✓ | – | ✓ | ✓¹ | camelCase args |
| bash | Run a shell command | 558 | 139 | ✓ | – | ✓ | ✓¹ | |
| grep | Search file contents | 1,054 | 263 | ✓ | ✓ | ✓ | ✓ | |
| find | Find files by glob | 631 | 157 | ✓ | ✓ | ✓ | ✓ | 1 use in 408 bench calls |
| ls | List a directory | 487 | 121 | ✓ | ✓ | ✓ | ✓ | |
| web_fetch | Fetch a URL as text (also PDF/Office) | 855 | 213 | ✓ | ✓ | ✓ | ✓ | |
| **zWork tools** (`sidecar-rust/src/tools/mod.rs`) | | | | | | | | |
| web_search | Web search (Exa → silent news fallback) | 371 | 92 | ✓ | ✓ | ✓ | ✓ | `query` not required (M4) |
| read_skill | Load a skill playbook | 256 | 64 | ✓ | ✓ | – | – | Results up to 64k chars (B2) |
| extract_document | Text from PDF/Word/Excel/PowerPoint (OCR) | 609 | 152 | ✓ | ✓ | – | ✓ | |
| ask_user | Ask the user a question and wait | 414 | 103 | ✓ | ✓ | – | – | |
| save_memory | Save a fact to memory files | 704 | 176 | ✓ | – | ✓ | – | Free-string target (M5) |
| update_todos | Show a progress checklist | 1,160 | 290 | ✓ | – | ✓ | – | Never used in bench |
| spawn_agent | Run a sub-agent and wait for its answer | 426 | 106 | ✓ | – | – | ✓² | Description wrong (M1) |
| manage_tasks | Local to-do list CRUD | 817 | 204 | ✓ | – | – | – | |
| manage_events | Local calendar CRUD (not Google) | 598 | 149 | ✓ | – | – | – | Confusable (R3) |
| manage_schedules | Create/edit recurring scheduled tasks | 1,829 | 457 | ✓ | – | – | – | Largest zWork schema |
| post_to_inbox | Post an item to the zWork Inbox | 1,262 | 315 | ✓ | – | – | – | |
| desktop_office | Edit .docx/.xlsx without a GUI | 1,226 | 306 | ✓ | – | – | – | Not a desktop tool (M7) |
| desktop_capture | Accessibility tree of an app window | 800 | 200 | ✓³ | – | – | – | 3/3 failed in real use |
| desktop_click | Click element by index | 450 | 112 | ✓³ | – | – | – | |
| desktop_type | Type into element | 581 | 145 | ✓³ | – | – | – | |
| desktop_set_value | Set a control's value | 744 | 186 | ✓³ | – | – | – | |
| desktop_scroll | Scroll an element | 450 | 112 | ✓³ | – | – | – | |
| desktop_key | Press keys / shortcuts | 725 | 181 | ✓³ | – | – | – | |
| desktop_launch_app | Open an app | 400 | 100 | ✓³ | – | – | – | |
| desktop_list_apps | List running/installed apps | 211 | 52 | ✓³ | – | – | – | 40k-char results (B2) |
| desktop_wait | Sleep N seconds | 327 | 81 | ✓³ | – | – | – | |
| desktop_start_session | Start the driver daemon | 429 | 107 | ✓³ | – | – | – | Empty schema (M8) |
| desktop_end_session | Stop the driver daemon | 461 | 115 | ✓³ | – | – | – | Empty schema (M8) |
| browser_navigate | Open URL in the user's Chrome | 307 | 76 | ✓⁴ | – | – | – | "No login walls"; hidden `tab_id` (M3) |
| browser_snapshot | Page elements as text | 423 | 105 | ✓⁴ | – | – | – | |
| browser_click | Click page element | 494 | 123 | ✓⁴ | – | – | – | ~9.7k-char results |
| browser_type | Type into page element | 560 | 140 | ✓⁴ | – | – | – | |
| browser_scroll | Scroll page | 365 | 91 | ✓⁴ | – | – | – | |
| browser_eval | Run JavaScript on page | 406 | 101 | ✓⁴ | – | – | – | 8/8 failed, CSP (B4) |
| browser_screenshot | Screenshot current tab | 212 | 53 | ✓⁴ | – | – | – | ~300k chars of base64 (B1) |
| browser_tabs | List open tabs | 184 | 46 | ✓⁴ | – | – | – | Empty schema; no switch tool |
| **Specialist** (only with a keyword) | | | | | | | | |
| search_papers | Academic paper search | 551 | 138 | Spec. | Spec. | – | ✓ | Sub-agent always gets it |
| format_citation | Format a citation | 406 | 102 | Spec. | Spec. | – | ✓ | `paper` object has no properties |
| write_research_paper | Draft a paper | 568 | 142 | Spec. | Spec. | – | – | |
| review_paper | Review a paper | 438 | 110 | Spec. | Spec. | – | – | |
| check_novelty | Novelty check | 504 | 126 | Spec. | Spec. | – | – | |
| get_stock_data | Stock prices | 431 | 108 | Spec. | Spec. | – | – | `default` keyword |
| detect_hardware | Local hardware info | 177 | 44 | Spec. | Spec. | – | – | Empty schema |
| ask_question | Duplicate of ask_user | 402 | 101 | Spec. | Spec. | – | – | Delete (R1) |
| ask_user_for_permission | Duplicate of the permission gate | 406 | 102 | Spec. | Spec. | – | – | Delete (R1) |
| deploy_web_app | Local dev-server preview | 360 | 90 | Spec. | – | – | – | "Public URL" is false (M2) |
| send_telegram_message | Send a Telegram message | 488 | 122 | Spec. | – | – | – | Errors return Ok (M5) |
| **Composio (Gmail connected)** | | | | | | | | |
| composio__GMAIL_* (7 core) | Fetch/read/list/send/reply/draft email | ≈5.2k | ≈1,294 | ✓ | ✓ (B8) | ✓⁵ | – | Plus a ≈ 870-token prompt block |

Footnotes:
1. In a sub-agent, `bash`, `write` and `edit` are wrapped so destructive actions are denied (`harness_turn.rs:1986-1990`).
2. `spawn_agent` is given only at depth 0 (`MAX_SUBAGENT_DEPTH = 1`, `harness_turn.rs:2071`, `:2296`).
3. Offered on every Mac (`cua/mod.rs:46-48`), whether or not permissions are granted.
4. Offered whether or not the Chrome bridge is connected.
5. The coding-only allowlist filters only `get_tool_schemas`. Composio and MCP tools are appended afterwards (`harness_turn.rs:1863`, `:1882`), so a bench machine with connected apps would leak them into coding-only runs.

**Totals per mode (measured on the wire):**

| Mode | Tools | Chars | ≈Tokens | System prompt |
|---|---:|---:|---:|---|
| Product, no connectors | 39 | 24,124 | **6,031** | 28,061 chars ≈ 7,015 (dev machine) |
| Product + specialist keyword | 50 | 28,855 | 7,214 | same |
| Product + Gmail | 46 (+ ~16 legacy) | ≈ 29.3k | ≈ 7.3k–8.1k | + ≈ 870 |
| Plan | 9 | 5,376 | 1,344 | 28,401 chars, still the full product prompt |
| Coding-only | 11 | 8,158 | 2,040 | 2,921 chars |
| Sub-agent | 13 | 8,382 | 2,096 | ≈ 425 chars |

Group subtotals (product):

| Group | Tools | ≈ Tokens |
|---|---:|---:|
| Desktop GUI | 11 | 1,391 |
| Organiser (tasks/events/schedules/inbox) | 4 | 1,125 |
| Browser | 8 | 735 |
| desktop_office | 1 | 306 |

---

## 3. Overlaps and confusion risks

Detail for the R-rows above, plus risks that aren't strictly duplicates.

- **Three tools read documents, and the obvious one breaks.**
  - `read` mangles a PDF (B3); `extract_document` handles it; `web_fetch` handles remote ones.
  - The prompt routes to `extract_document` (`settings.rs:594`, `:735`). Mid-tier models still try `read` first because it is the generic name.
  - A one-line redirect in `read`'s result is cheaper than more prompt text.
- **Browser vs desktop.**
  - Both can operate Chrome, and the three instructions about falling back disagree (B6).
  - The skills to load first differ (`computer-use` vs `zbctl-browser`, `settings.rs:693-694`).
  - The rule "Never mix the two on the same app" (`:699-700`) needs the model to know which app a browser tool is driving, which it can't see.
- **The organiser cluster.**
  - "Remind me every Monday" could reasonably map to `manage_schedules`, `manage_tasks`, `manage_events`, `post_to_inbox` or, with Calendar connected, `composio__GOOGLECALENDAR_*`.
  - Only the schedules description explains itself at length (1,829 chars). Users will expect "my calendar" to mean Google Calendar, not `manage_events`.
- **Office files.** There are three routes: `desktop_office`, python via `bash` (what the prompt and the bench model prefer), and the `docx`/`xlsx` skills.
- **Asking the user.** `ask_user`, `ask_question` and `ask_user_for_permission` compete. `ask_question` returned "User did not respond" in 2 of 3 real calls.
- **Notifying the user.** `post_to_inbox` vs `send_telegram_message`.
- **Sub-agent model choice.** `spawn_agent.model_id` lets the model pick a model by name. It has no list of valid ids, and the fallback is not the chat's model (M1).
- **Argument naming drift.** camelCase vs snake_case, `element` vs `element_id`, and the inconsistent `app` requirement. Mid-tier models copy argument names across similar tools.
- **The prompt contradicts the tool list.** "All tools below are available every turn" (`settings.rs:339`) and Composio tool names when nothing is connected (`:673-681`) both teach the model to call tools that aren't there (M6). Combined with the bare "unavailable" error (B7), the model has no path to recover.

What the evidence does **not** show: in the bench, GLM 5.3 never called a wrong or non-existent tool and never failed schema validation. The commit message for `66636d9` attributes zWork's bench misses to not checking results, not to choosing the wrong tool. **The case for a lean list is cost, removing tools that can't work, and removing duplicates. Tool-choice confusion on these office tasks is not evidenced.** The local log does show the failure modes B1, B2, B4 and B5 in real use.

---

## 4. Evidence from real runs (aggregates only)

### Bench

Source: `bench/lite/runs/20261116-*`, 5 runs, 56 `agent.jsonl` files. GLM 5.3 via Z.ai, commits `bcad87c`/`7e824b4`, product mode (not coding-only).

**Calls per tool (408 total):**

| Tool | Calls |
|---|---:|
| read | 148 |
| bash | 131 |
| write | 55 |
| edit | 37 |
| ls | 29 |
| grep | 3 |
| extract_document | 2 |
| read_skill | 2 |
| find | 1 |

- **9 of 39 offered tools used.** Never called: `update_todos`, `web_search`, `web_fetch`, every `browser_*`/`desktop_*`, every `manage_*`, `post_to_inbox`, `spawn_agent`, `save_memory`, `ask_user`.
  - Some of this is task mix: the bench tasks are file paperwork.
  - `update_todos` is pushed by the prompt for multi-step work and was still never called.
- **Failures:** 9, all `bash` script errors (the script failed, not the tool call). **0** schema-validation failures, **0** unknown tools.
- **Token profile:**
  - 322 model steps; 4.95M prompt tokens; 87.2% cached.
  - Per-step prompt: median 13,776, mean 15,370.
  - First step: median 12,616; cached 5,888 = the tool block (C2).

### Local app log

Source: the user's own app, 2026-08-28 to 2026-11-16, 21 chats, 279 tool calls, 20 failed, 28 distinct tools. Includes some pre-port tool names such as `run_command`.

| Tool | Calls | Failed | Note |
|---|---:|---:|---|
| browser_click | 62 | 2 | ~9.7k-char results each |
| composio__GMAIL_FETCH_EMAILS | 35 | 0 | 15 with empty args; same call repeated 3–4× in two chats |
| bash | 25 | 3 | |
| read | 24 | 0 | |
| run_command (legacy name) | 21 | 1 | Removed tool, older version |
| composio__GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID | 21 | 0 | |
| browser_snapshot | 14 | 0 | Repeated 3–4× in a row in places |
| browser_eval | 8 | **8** | All CSP (B4) |
| browser_screenshot | 8 | 0 | **308k–356k chars each** (B1); identical call repeated 4× in two chats |
| browser_scroll | 7 | 0 | |
| ls | 6 | 1 | |
| save_memory | 6 | 0 | |
| desktop_start_session | 4 | 0 | |
| update_todos | 4 | 0 | |
| browser_tabs | 4 | 0 | |
| desktop_capture | 3 | **3** | Empty accessibility tree (B5) |
| ask_question | 3 | 2 | "User did not respond" |

- Other oversized results: `desktop_list_apps` 40,871 chars; `read_skill` up to 63,746 chars (B2).
- A September request offered **88 tools** (Composio Gmail + Notion + legacy). The current build offers 39 plus connectors.

### Probe

What the model actually receives. Scratch sidecar plus a scripted mock; the tool results are verbatim.

| Call | Model receives |
|---|---|
| any `browser_*`, bridge down | the 185-char "zbctl extension" error (B6) |
| `not_a_real_tool` | `Tool "not_a_real_tool" is unavailable` (B7) |
| `send_telegram_message` / `deploy_web_app` / `format_citation` when gated out | the same bare "unavailable" (B7) |
| `read sample.pdf` | raw PDF bytes (B3) |
| `read {}` | "Validation failed for tool "read": - path: Expected required property …". Clear and actionable |
| `save_memory {target:"bogus"}` | "Saved to MEMORY.md." (M5) |
| `manage_tasks {}` | validation error, though the executor defaults to list (M11) |
| `browser_click {element_id:"5"}` | string coerced to number, then the bridge error |

---

## 5. Lean-by-default proposal

### Principle

Offer what the turn can actually use, decide it at turn start, and only ever *add* to it during a chat.
- The OpenAI-compatible path can't add tools mid-conversation (`supports_mid_convo_tool_additions: false`, `openai_completions.rs:149`).
- Every change to the tool array breaks the prompt cache from that point on.

### Core set: always on in product mode

14 tools, ≈ 2,350 tokens:

`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `extract_document`, `read_skill`, `ask_user`, `update_todos`, `save_memory`

- Optionally add `spawn_agent` (+106).
- Dropping `find` and trimming the three longest descriptions (`edit` 1,194 chars, `update_todos` 1,160, `grep` 1,054) gets the core to ≈ 1.9k tokens.

### Groups: added at turn start when a signal fires, then sticky for the chat

| Group | Tools | ≈ Tokens | Offer when |
|---|---|---:|---|
| Browser | navigate, snapshot, click, type, scroll, tabs (drop `eval` and `screenshot` until B1/B4 are fixed) | ≈ 580 | Bridge connected **and** (a URL/site in the message, or "website / log in / form / in Chrome", or the chat already used a browser tool) |
| Desktop | capture, click, type, set_value, scroll, key, launch_app, list_apps, wait (session tools made implicit) | ≈ 1,170 | Permissions granted **and** (an installed app is named, "on my Mac/desktop", or the chat already used one) |
| Office editing | `office_edit` (renamed `desktop_office`) | ≈ 306 | A .docx/.xlsx is attached or named and the message asks to change it, or drop it entirely (M7) |
| Organiser | manage_tasks, manage_schedules, post_to_inbox (manage_events only if no Google Calendar) | ≈ 980–1,125 | remind / every / each week / tomorrow / schedule / to-do / calendar, and **always** in scheduled runs |
| Each connected Composio app | Only its core tools (Gmail 7 ≈ 1.3k), and that app's lines in the prompt block | per app | App connected **and** (mentioned: email/inbox/Gmail, meeting/calendar, Drive/doc) or the chat already used it |
| Academic / specialist | search_papers, format_citation, write_research_paper, review_paper, check_novelty, get_stock_data | ≈ 730 | An explicit setting ("Academic mode") or the current keywords, but **sticky**. Delete `ask_question` and `ask_user_for_permission`. Put `deploy_web_app` (renamed) and `send_telegram_message` behind settings |
| MCP servers | As today | – | Server enabled |

**Recovering from a miss.**
- Make the "unavailable" error say which group the tool belongs to and that it will be loaded on the next message.
- Optionally add a `load_tools(group)` tool. It costs one round trip, and because tools can't be added mid-step, the harness would have to rebuild the tool list before the next step. That breaks the cache once, which is acceptable for a miss.

### Savings

| | Tool tokens per call | Saved vs today |
|---|---:|---:|
| Today, product | 6,031 | – |
| Lean, no group triggered (core + spawn_agent) | ≈ 2,450 | ≈ 3,600 (−60% of the tool block) |
| Lean + browser (bridge on) | ≈ 3,030 | ≈ 3,000 |
| Lean + Gmail | ≈ 3,750 + 870 prompt | ≈ 3,600 vs today's Gmail turn |

- On the bench token profile, about 3.6k tokens off each of 322 steps is ≈ 1.16M of 4.95M prompt tokens, **≈ 23% fewer prompt tokens**.
- Not importing other agents' skill folders (M10) saves ≈ 1.7k more on dev machines.
- Replacing the hand-written Tools section with per-tool snippets (M9) saves up to ≈ 1.2k.

### Keeping the prompt cache stable

1. **Fixed order:** core tools first, in a fixed order. Then groups in a fixed group order, sorted within each group. Today's alphabetical sort over everything (`harness_turn.rs:1890`) puts a newly added tool in the middle of the array.
2. **Add-only within a chat:** once a group is offered, it stays for the chat. That means at most one cache break per group per chat. History never names a tool that has disappeared, unlike keyword gating today (C3).
3. **Keep volatile facts out of the system prompt:** the minute-resolution time (`memory.rs:290`), the browser status (`harness_turn.rs:1784-1793`) and which groups loaded this turn should go in the per-turn context on the latest user message (the existing mechanism below `harness_turn.rs:1794`). The system prompt and tool block then stay byte-identical across a chat's messages, not only across the steps of one turn (C2).
4. **Cache Composio schemas per session** and sort them deterministically, instead of fetching on every turn (C4).

### Providers without a prompt cache

- Without a cache, every step re-pays the full prefix. With today's ≈ 13k fixed prefix, a 20-step task spends ≈ 260k prompt tokens on the prefix alone.
- Lean-by-default cuts that by ≈ 72k on tool schemas, ≈ 28%. Fixing M9 and M10 cuts it further.
- On these providers, trimming the prefix matters more than cache-stability work, and a `load_tools` round trip (one extra full-prefix call) is relatively more expensive. That is another reason to choose groups well at turn start.

### Suggested order of work

1. B1 and B2: screenshot as an image, and truncation of zWork tool results. Biggest real-world cost, small change.
2. B3: `read` redirects binaries.
3. B5 and B6: offer desktop/browser tools only when they can work, with one plain-language rule.
4. C2: move the time out of the system prompt.
5. B8: plan mode filters Composio writes.
6. M1–M6: description fixes. Delete the duplicate ask tools.
7. A schema-lint unit test, and sanitising Composio schemas in the cloud.
8. Lean core + sticky groups (section 5).
