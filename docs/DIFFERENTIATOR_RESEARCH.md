# Differentiator research: what to stand on at launch

Written 2026-11-08. Question: what is one real, defensible differentiating feature
for zWork at launch? Researched against primary sources (official help docs, pricing
pages) plus dated complaint evidence. Supplements `POSITIONING.md` (2026-10-06).

## TL;DR

| Product | Recurring story | Deliverable | Failure behavior | Price |
|---|---|---|---|---|
| ChatGPT scheduled tasks | Yes; **5 active tasks on Plus** (3 Free/Go, 10 Business/Edu, 15 Pro) | Chat replies + push/email notifications. **Tasks cannot access files** | "A task may pause if it is inactive, requires additional action…" — pause can go unnoticed | $20 Plus |
| Claude Cowork scheduled tasks | Yes, `/schedule`, any cadence; **runs in the cloud** | "Finished outputs to your session, where you can preview and download them" | Permission handling for unattended runs undocumented; users report silent deaths and ignored "Always allow" | $20 Pro |
| Gemini scheduled actions | Yes; **10 active schedules**, requires AI Pro/Ultra | Chat/app notifications | Not documented | $20+ AI Pro |
| Lindy | Yes (agents) | Cloud artifacts | Credit burn (one triage run: 250–1,000 credits) | $29.99+/mo + credits |
| Zapier Agents | Yes (Zaps) | App actions; task-metered | Not documented | ~$20–30/mo, task-based, costs balloon |
| **zWork** | **Unlimited schedules** | **Real `.xlsx`/`.docx` written into the user's folders** | **Honesty rules + inbox report (to be productized)** | **$12** |

Nobody in the consumer set verifies the file it hands back, and nobody shows the
user a per-run record of what happened. That is the gap.

## ChatGPT scheduled tasks (primary source)

Source: OpenAI Help Center, "Scheduled tasks in ChatGPT",
help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt (retrieved 2026-11-08).

- Limits, quoted: "Active task limits depend on the plan: 3 for Free and Go, 5 for
  Plus, 10 for Business and Edu, and 15 for Pro and Enterprise."
- "Free users can schedule a one-time task or a recurring task no more than once per
  day." Hourly schedules and exact delivery times need a paid plan.
- Files, quoted: "If you create a task in a project, it cannot access uploaded files
  or files stored in that project." Tasks deliver chat updates and notifications
  ("Push, Email, or both") — there is no documented path for a task to write a real
  `.xlsx`/`.docx` into the user's folders.
- Failure behavior, quoted: "A task may pause if it is inactive, requires additional
  action, or its associated chat is archived or deleted." Also: "If approval is
  required, the task pauses until you review it." A paused task is discovered only
  when the user checks the Scheduled page.
- Complaints: r/ChatGPT "A 5-task limit on scheduled tasks is absurd"
  (reddit.com/r/ChatGPT/comments/1vovs2v); OpenAI community reports of missed runs
  and tasks not triggering (community.openai.com threads, Oct 2026).

## Claude Cowork scheduled tasks (primary source)

Source: Claude Help Center, "Get started with Claude Cowork",
support.claude.com/en/articles/13345190-get-started-with-claude-cowork (retrieved
2026-11-08). Note: this updates `POSITIONING.md`'s table, which says "Local
scheduled tasks while the app is open."

- Scheduling: `/schedule` in any Cowork task, "automatically on a cadence of your
  choosing."
- Where they run, quoted: "Scheduled tasks run in the cloud, so they don't need your
  computer to be awake or the desktop app open."
- Deliverable, quoted: "finished outputs to your session, where you can preview and
  download them" — a session download, not a verified file written where the user
  keeps their work.
- Permissions: the page documents modes (Manual, Auto, Skip) generally but does not
  describe how an unattended scheduled run handles approvals.
- Complaints (Reddit, 2026): "Latest release took away permissions to scheduled
  tasks" (r/ClaudeCowork 1wnqpxo); "Schedule task issues" — tasks demand permission
  with skip-permissions enabled (r/ClaudeAI 1stgcpm); "[BUG] Cowork scheduled tasks
  ignore 'Always allow'" (Apr 2026); a scheduled task writing logs to a Desktop
  folder "silently died on a permission error" every run via launchd;
  "Scheduled tasks won't run (run now disabled?)" on Mac.

## Gemini scheduled actions

Sources: support.google.com/gemini/answer/16316416; blog.google scheduled-actions
announcement (June 2025); 2026 coverage.

- Up to 10 active schedules; minimum 15-minute interval; requires Google AI
  Pro/Ultra or qualifying Workspace plans.
- A May 2026 piece criticizes the 10-cap as restrictive even for $20/mo AI Pro
  subscribers.
- Deliverables are chat/app notifications; no verified local file output.

## Output-fidelity pain evidence

- An Oct 2026 head-to-head ("I asked ChatGPT, Claude, and Gemini to fix the same
  spreadsheet") reports Gemini "didn't help fix the spreadsheet and made completely
  wrong" changes.
- r/excel threads describe ChatGPT-written formulas as helpful-but-unreliable;
  purpose-built "AI spreadsheet formula fixer" tools exist as a category in 2026
  (e.g. aiagentslibrary.com/skills/spreadsheet-formula-fixer) — evidence that broken
  AI spreadsheet output is common enough to sustain fixer products.
- Verification guides ("here's how to check ChatGPT's Excel work before trusting
  it") exist because the failure mode is expected.

## Receipts / audit trails: who has them

A cluster of Sep–Oct 2026 products market per-run agent "receipts" — PipeLab
("Agent Action Receipts: Signed AI Audit Evidence", Sep 29, 2026), Praesidia
(offline-verifiable audit trails, Sep 14, 2026), Adaptius ("Every AI agent should
leave a receipt", Oct 6, 2026), SovereignClaw ("Authority Receipt"), plus
compliance/SRE audit guides. All are enterprise/governance tooling: signed
evidence, quorum verification, keys outside agent reach, aimed at platform and
compliance teams. None is a consumer agent feature, and none verifies the
*deliverable* (the file) — they verify the *actions*.

## Hypothesis verdicts

- **H1 — "Recurring unattended run + a receipt you can trust" is unclaimed by major
  players: CONFIRMED.** ChatGPT pauses tasks silently and notifies with pings, not
  records; Cowork's unattended permission behavior is undocumented and its users
  report silent run deaths; enterprise receipt products exist but not in any
  consumer agent. The consumer version — plain-language "what I read / what I
  changed / what I couldn't reach / files made" per run — is unclaimed.
- **H2 — "Original-format deliverable guarantee" is unclaimed: CONFIRMED.** ChatGPT
  tasks cannot access files at all (help doc, quoted); Cowork delivers session
  downloads with no verification story; Gemini is chat-first. Nobody guarantees the
  file opens right, recalculates clean, and matches the source. Pain is documented
  (formula-fixer category; Oct 2026 head-to-head).
- **H3 — Trust gap is the #1 abandonment reason: PARTIAL.** Silent failures and
  output distrust are well documented (above), but no surveyed data ranks the
  abandonment cause. Do not cite this as "the #1 reason" without a survey; cite the
  specific documented failure modes instead.

## Pricing anchors (Nov 2026)

| Product | Entry price for scheduled agent work |
|---|---|
| ChatGPT Plus | $20/mo, 5 active tasks |
| Claude Pro (Cowork) | $20/mo |
| Google AI Pro (scheduled actions) | $20/mo, 10 schedules |
| Lindy | $29.99/mo + credits ($0.01/credit; complex runs 250–1,000 credits) |
| Zapier | ~$19.99–29.99/mo, task-metered; user reports of $70 → $847/mo growth |
| zWork Pro | $12/mo, unlimited schedules; free with own key |

zWork's "unlimited schedules" beats hard-capped limits at every competitor, but a
limit bump is trivially copyable — a table row, not a moat.

## What this suggests (interpretation, separate from evidence)

The launch differentiator should be one named, marketed capability built from what
the repo already has:

**Every scheduled run ends in (a) a real Excel/Word file that was verified after it
was written, and (b) a plain-language receipt of what the run did.**

- (a) is `POSITIONING.md` P0.1 (recalculate formulas, fail on `#REF!`/`#VALUE!`/
  `#DIV/0!`, re-read totals against source, render and look at it, feed failures
  back automatically).
- (b) is P1.7 (the inbox as the record of every run: read / changed / waiting to
  send / files produced).

Why defensible: OpenAI's cloud tasks architecturally cannot write files on the
user's machine; Cowork's scheduled runs are cloud sessions whose permission model
is its users' top complaint — copying zWork means fixing that first, not just
shipping UI. And the verification loop compounds: it is what makes cheap routed
models safe enough to keep unit cost under $4, which protects the $12 price.

Why it sells: the target user (bookkeeper, office manager) treats a *wrong*
expense report as worse than none. "It never hands you a broken spreadsheet, and it
shows you exactly what it did" is the sentence the landing page can prove.

Do NOT differentiate on: "runs while your laptop is closed" (Cowork cloud already
does; P2 me-too), unlimited schedules (copyable), model choice (not understood by
the audience).
