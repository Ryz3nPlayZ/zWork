# Desktop control, the 2M-token run, and oh-my-pi

Date: 2026-11-16. Code references are to `site/redesign` after `fafdc12`. Run figures are aggregate only.

The run was a GLM 5.3 chat asking "what can you do for me". The app footer showed about 1.97M input tokens, 2.9k output tokens and $0.15, and about 20 "grant CuaDriver access" cards came up while both permissions were granted. This note explains all three and asks whether CuaDriver is the right base for desktop control, and whether zWork should move onto oh-my-pi (OMP).

## 1. Why the run used about 2M input tokens

The number is real. It is 19 model calls, each re-sending a context of 85–115k tokens. Most of it was billed as cache reads, which is why the cost stayed at $0.15. Two things made each call that large.

- **Every connected-app tool goes into every request.** Before Notion was connected, a first call was about 24k tokens. After, it was about 85k. Notion and Gmail together add 65 Composio tools (104 tools in total), and their schemas come to roughly 74k tokens. `connectors/composio.rs` `all_tool_schemas` fetches every tool of every connected app, and `agent/harness_turn.rs` adds all of them to every call, whether the request needs that app or not.
- **One oversized result stayed in context for the rest of the run.** `desktop_list_apps` returned about 40k characters (about 13k tokens), listing every installed app rather than the ones running. Every later call carried it.

The output side (2.9k tokens) shows that the model was not looping or rambling. The cost is all re-sent input.

## 2. Why the permission cards appeared

They were false alarms. `agent/mod.rs` `is_cuadriver_permission_error` matched any error text containing "cuadriver" or "cua-driver". The driver puts its own name in every error: a missing window, a stale element number, a keystroke it couldn't confirm. So every ordinary desktop failure showed the user a "grant CuaDriver access" card.

**Fixed in `fafdc12`:**

- The matcher now looks only for the driver's real not-granted messages ("Missing TCC grant", "is NOT granted") and for a driver that is down.
- Before showing a card, zWork asks the running driver whether both grants are on, and skips the card if they are.
- An empty accessibility tree with permissions granted now tells the model to wait and capture again, instead of claiming permissions are missing.

## 3. Why desktop control kept failing

The run's desktop errors were not permission problems. zWork's wrapper (`cua/mod.rs`) was written for an older driver API. The installed driver is 0.22.1, and the wrapper misuses that version in three ways.

| # | What the wrapper does | What driver 0.22.1 expects | Effect in the run |
|---|---|---|---|
| D1 | `click`, `key` and `set_value` send a bare `element_index` | `element_token`, or `element_index` together with the `snapshot_id` from the capture that produced it | Element actions are rejected |
| D2 | `type_text` sends `window_id` only when an element is given | `window_id` (or `scope: "desktop"`) on every call; without an element the text goes to the focused field | Typing into the focused field fails |
| D3 | `resolve_window_id` takes the first on-screen window with an id | The window the user means, normally the frontmost titled one | `window_not_found` on apps with helper or panel windows |

Two smaller problems compound these:

- `capture` ignores `snapshot_id` and `element_token` in the reply, so the wrapper has nothing correct to send back.
- It never passes `max_elements`, `query` or `include_screenshot: false`, so captures of large apps are bigger and slower than they need to be.

After a few failures the model gave up on the desktop tools and used `bash open -a`, which is the right instinct but bypasses everything the tools are meant to do.

For browser tabs, the driver itself reports keystrokes as "unverifiable" and recommends a browser-aware path. zWork already has `browser_*` tools, so web pages should be routed there rather than through desktop control.

## 4. Is CuaDriver the best option?

The options that fit a macOS desktop app for non-technical users:

| Option | How it works | For zWork | Against |
|---|---|---|---|
| **CuaDriver** (trycua, MIT) | Separate signed app and daemon; MCP over a socket; accessibility tree plus screenshots; background input | Already integrated; cross-platform; active project with structured elements, snapshot ids and verify tools | The permission grants belong to a second app, which confuses users. A second process can hang, be missing or be the wrong version. Background input relies on an undocumented macOS framework. The API moves fast, and our wrapper fell behind it |
| **Peekaboo** | macOS-only CLI and MCP server (stdio), 20-plus tools, macOS 15+ | Mature macOS focus | Same two-app permission problem; macOS only; another process to manage |
| **OMP's desktop module** | Rust code compiled into the agent itself (`crates/pi-natives/src/desktop`, about 10.6k lines, objc2 calls into the macOS accessibility API) | No second app, so the grants go to zWork and the "grant it to CuaDriver, not zWork" trap disappears. Element refs like `e12` with explicit stale-ref errors. Detects when the user takes over. Physical Esc to stop. Menus are driven by name | Coding-agent origin; we would own the code; it would need porting into the sidecar and its own tests |
| **Plain pixels** (screenshot plus click by coordinate) | Vision model reads the screen | Works on anything visible | Far more tokens per step, slower and less reliable than the accessibility tree; GLM-class models are weak at it |

Published comparisons and the driver authors agree that the accessibility tree is cheaper and more reliable than pixels, with screenshots as the fallback. All three structured options take that approach, so the difference is packaging, not capability.

**Verdict.** CuaDriver is not the problem in this run. Our wrapper is, and it can be fixed in days. The real long-term cost of CuaDriver is the second app and its permissions, which keep confusing the people zWork is for. OMP's module removes that cost because it runs inside zWork, and its core is plain Rust with no Node bindings in the backend, so it can be moved into the sidecar.

## 5. Should zWork move onto OMP?

**Not wholesale.** OMP is a fork of pi-mono, which zWork's agent loop is already ported from, so the ideas transfer easily. The product does not:

- It is a coding-first terminal agent in TypeScript on Bun with Rust add-ons. zWork is a Rust sidecar behind a desktop app for office work.
- Its defaults, prompts and tools assume a developer at a terminal. Desktop control is off by default and reached through its code-eval tool.
- Moving onto it would mean replacing the agent loop, the session store, connectors, billing tags and the app bridge, and would bring back the tradeoffs we just finished paying for in the pi port.

**What to take from it:**

| OMP piece | What it does | Where it helps zWork |
|---|---|---|
| Essential and discoverable tools | About 13 tools are always offered; everything else is listed by name and loaded only when the model asks for it | Solves the 74k-token Composio problem directly: offer "Notion" and "Gmail" as entries the model can open, not 65 full schemas |
| Pruning old tool output | Old results are replaced with "[Output truncated - N tokens]" (results under 50 tokens are kept) or moved to `artifact://` references that can be re-read | Stops a 40k-character list or an 80k screenshot riding along for the rest of a chat |
| Head-and-tail truncation | Long output keeps the first 60% and the end, about 2,000 characters | Better than cutting the tail, where errors usually are |
| Compaction during a turn | Compacts when a threshold is crossed, not only between turns | Long desktop or browser runs stop growing without limit |
| Hashline edits | Each line carries a short hash, so edits name lines rather than reproduce text | On OMP's benchmark a weaker model went from 6.7% to 68.3% on edits. Worth a bench run for our file-editing office tasks |
| Desktop module | In-process accessibility control (section 4) | Replaces CuaDriver later, once the wrapper fixes have shown what we need |

## 6. Plan, in order

1. **Done:** permission cards only for real permission problems (`fafdc12`).
2. **Fix the CuaDriver wrapper for driver 0.22.1** (D1–D3):
   - keep `snapshot_id` and element tokens from each capture and send them back;
   - always send `window_id`, and pick the frontmost titled window;
   - capture with `max_elements` and without the inline screenshot;
   - route browser tabs to `browser_*`.
   Test on a scratch sidecar against TextEdit, Notes and Finder.
3. **Shrink `desktop_list_apps`** to running apps, with a short cap.
4. **Lazy connected-app tools.** Offer one entry per connected app; the full schemas load when the model opens it. Expected effect on this run: about 85k down to about 25k per call, so the 2M run becomes roughly 0.5M.
5. **Prune and summarise old tool output** the way OMP does. This overlaps phase 1 of the earlier plan in [README.md](README.md) (screenshots as images, not text).
6. **Prototype OMP's desktop module inside the sidecar** behind a setting, and compare it with the fixed CuaDriver wrapper on the same desktop tasks. Switch only if it wins on reliability, and if dropping the second app clearly helps setup.

Steps 2–4 are small and independent; 5 follows the earlier plan; 6 is a separate project.

## Sources

- oh-my-pi repository and docs: [github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (README, `docs/computer-use.md`, `docs/compaction.md`, `crates/pi-natives/src/desktop/`)
- The Harness Problem (hashline edits): [blog.can.ac](https://blog.can.ac/2026/02/12/the-harness-problem/); summaries at [dev.to](https://dev.to/alexchen31337/the-harness-problem-is-real-and-the-edit-tool-is-where-it-starts-nff) and [Alibaba Cloud](https://www.alibabacloud.com/blog/602970)
- Computer-use options: [Pinggy, best computer-use MCP servers](https://pinggy.io/blog/best_computer_use_mcp_servers/), [codenote, selection notes 2026](https://codenote.net/en/posts/computer-use-agents-macos-windows-selection-notes-2026/), [andrew.ooo on trycua/cua](https://andrew.ooo/posts/trycua-cua-open-source-computer-use-agents/), [Simular, computer-use MCP alternatives](https://www.simular.ai/alternatives/best-computer-use-mcp-servers)
- CuaDriver 0.22.1: `cua-driver list-tools` and `cua-driver describe <tool>` on the installed app
