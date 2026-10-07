# zWork positioning and strategy

Written 2026-10-06. This replaces the "ChatGPT tells you how, zWork does it" line in
`LANDING_PAGE_BRIEF.md` and the technical-user framing in the old `PRODUCT.md`.

## The honest starting point

"An AI that does things on your computer" is no longer a product. In October 2026 it is a
feature everyone ships:

| Product | Price for the agent | Where it works | Models | Recurring jobs |
|---|---|---|---|---|
| ChatGPT agent | $20 Plus (not on Free or $8 Go) | OpenAI's cloud browser | GPT only | Scheduled tasks, but no files inside a task |
| Claude Cowork | $20 Pro | Your computer, your files, Microsoft 365 integration | Claude only | Local scheduled tasks while the app is open |
| Perplexity Computer | $200 Max | Cloud | Perplexity's routing | Yes |
| Manus | $20–40 in credits that run out | Cloud VM | Manus's routing | Yes |
| QoderWork, TRAE Work, WorkBuddy | Free or cheap in China, backed by Alibaba, ByteDance and Tencent | Your computer | Their own | Varies |
| **zWork** | **Free with your own key, $12 Pro** | **Your computer** | **Any of 200+, including local** | **Unlimited schedules on Pro** |

Every one of these can browse, read files and write documents. A feature list will not win. Claude
Cowork is the closest match and the real threat: it is local, works with files, has scheduled
tasks, and has a brand that people trust.

So the question "why would anyone trust zWork over ChatGPT?" has a blunt answer. **For general
use, they shouldn't, and we should stop asking them to.** No one picks the small, unknown
general-purpose assistant over the famous one. People pick the small one when it does *one
specific job* better and charges less for it.

## What we actually have that they don't

These are the things that are true today and hard for the big companies to copy.

1. **Price.** At $12, zWork Pro is the cheapest real agent from a Western company. ChatGPT's
   $8 Go plan has no agent, and every comparable agent starts at $20. zWork is also free with
   your own key or a local model. We can sustain $12 because we don't depend on one lab: cheap
   open models do most steps. OpenAI and Anthropic cannot route their agents through somebody
   else's cheaper model.
2. **Your computer, your files, your model.** Work happens in your folders, with no file
   uploads and no size limits. You choose which company, if any, sees the text. ChatGPT's agent
   runs in OpenAI's cloud. Cowork only runs Claude.
3. **It asks first and shows its work.** Anything that sends, edits or deletes waits for your
   OK. Every step is shown, and the code is public. For a small business letting an AI near the
   books or the client inbox, "you can see exactly what it did" is the trust argument. Brand is
   not.
4. **Recurring jobs are the main feature.** Scheduled agents report to an inbox, keep running
   from the menu bar, and are unlimited on Pro. For ChatGPT and Cowork, schedules are a side
   feature.

None of these is enough alone. Together they point to one wedge.

## The wedge: recurring office paperwork for people who pay for their own tools

**Who.** People who pay for their own software out of their own pocket or a small budget,
and who live in Excel, Word, PDFs and email:

- solo business owners and freelancers;
- bookkeepers;
- office and operations managers at companies of 2–50 people;
- assistants and admins.

They are not technical. They already feel that $20 a month per AI tool adds up, and they have
the same chores every week or every month.

**The job.** Paperwork that repeats:

- turn this month's bank or card export into the expense report;
- chase unpaid invoices and draft the reminder emails;
- build the weekly client or status update from the inbox and the tracker;
- fill this template for each new client or order;
- reconcile two spreadsheets and flag what doesn't match;
- read every PDF invoice in this folder into one sheet.

**Why us for this job.**

- The files are on their computer: a folder of PDFs, a QuickBooks or bank export, the Excel
  template the accountant insists on. zWork works on them in place.
- They want the result in **Excel and Word**, not a chat reply or a Google Doc.
- It happens **every week**, and zWork is built around schedules and an inbox.
- It touches money and clients. Approval before sending, plus a visible record, is what makes it
  safe enough to hand over.
- The buyer is price-sensitive, which is exactly where $12 beats $20.

I also considered students: they are price-sensitive and the academic pipeline exists. I
rejected them as the lead. ChatGPT is free or $8 for them, their work is chat-shaped rather
than recurring, and they churn every semester.

## One-sentence positioning

> **zWork does your weekly paperwork on your own computer, in real Excel and Word files, and
> asks before anything leaves. $12 a month, less than any other AI agent.**

The short version for the hero: **"Your weekly paperwork, done."**

## How to answer "why not just use ChatGPT?"

Use this in the FAQ, sales replies and anything else that gets asked:

> Use ChatGPT for questions. Use zWork for the jobs you do every week. It works on the files
> already on your computer, so nothing gets uploaded, and it gives you back a real Excel or Word
> file. It can do the job on a schedule and asks before it sends or deletes anything. It costs
> $12 instead of $20, and it's free if you bring your own AI key.

Don't claim that zWork is smarter, that it is the only one that "does things", or that the others
are chatbots. Those claims were true in 2025. They are false now, and a buyer who has seen
Cowork will stop reading.

## What to advertise

Lead with the job and the result, then trust, then price. Leave features for later on the page.

1. **Hero.** "Your weekly paperwork, done." Under it: "zWork is an AI assistant on your computer
   for the reports, spreadsheets and emails you redo every week. Show it the job once and it
   does it on schedule, in real Excel and Word files, and asks before anything is sent."
2. **Four recurring jobs, each with a before and an after:**
   - the expense report from a bank export;
   - invoice chasing;
   - the weekly client update;
   - a folder of PDF invoices turned into one sheet.

   Show the real `.xlsx` and `.docx` files at the end, open in Excel and Word. Don't show a
   chat bubble.
3. **Trust.** It works on your computer. It asks before sending, editing or deleting. Every run
   is logged in your inbox. The code is public.
4. **Price.** "$12. Less than ChatGPT Plus, and free with your own key."
5. **Features, last:** browser use, connectors, any model, helper agents, skills.

Stop leading with:

- "runs the commands", terminal steps, "Ran Python script…" and helper agents in the hero
  area. This is developer framing, and it scares the target user.
- the academic pipeline (novelty check, paper writing, review). Keep the code and ship it as an
  optional skill pack, but stop marketing it.
- "200+ providers" as a headline. Our users don't know what a provider is. Say "works with
  ChatGPT, Claude, Gemini or free local models".

## What to fix or build, in order

Ranked by how much each one decides whether the wedge works. P0 comes before anything else.

### P0: the promise has to be true

1. **Office output you never have to fix.** "Real Excel and Word files" is the core promise.
   Today the agent writes Python scripts that call openpyxl, python-docx and python-pptx. The
   files open, but nothing checks them.
   - Add a verification step that runs after every Office file is written:
     - recalculate the formulas and fail on `#REF!`, `#VALUE!` or `#DIV/0!`;
     - check the sheet has a header row, frozen panes on tables, and sensible column widths
       and number formats;
     - render to PDF and images through LibreOffice when it's available, so the agent can look
       at what it made;
     - re-read the totals against the source data.
   - Feed any failure back to the agent automatically.
   - Bundle a small "office paperwork" skill: house style for reports and expense sheets,
     invoice templates, mail merge, pivot-style summaries, charts. Its descriptions should be
     written for the jobs above, not for "docx manipulation".
2. **Microsoft 365 as a first-class connector set.** Our users are on Outlook and OneDrive at
   least as often as Gmail. Make Outlook mail and calendar, OneDrive and Excel Online the
   default tiles next to Gmail, Drive and Sheets. Composio has these toolkits. Each one needs a
   working end-to-end test of the jobs above, not just "connected".
3. **Trim product mode.** Right now about 43k characters of system prompt and 50 tool schemas go
   to the model on every turn. That makes each run expensive, which threatens the $12 price,
   and makes cheap models worse.
   - Hide the coding, deploy, academic and browser-automation-CLI tools in product mode.
   - Load skills only when they apply.
   - Target: under 15k characters and under 25 tools for a paperwork run.
4. **Job templates in onboarding.** Five minutes from install to the first scheduled job:
   1. Pick a job from a gallery of the six jobs above.
   2. Point it at the folder or connect the mailbox.
   3. Watch the first run.
   4. Approve the schedule.

   The first session should end with a recurring job saved. Today it ends with an empty chat
   box.

### P1: make it hold up week after week

5. **Artifacts, narrowed.** Stop building a general workspace with an in-app doc editor, sheet
   editor, graphs, todo and calendar (`ROADMAP.md`, "V1 Artifact Workspace"). That competes with
   Word, Excel and Notion and will always feel half-built. An artifact should be **the
   deliverable card** for a run:
   - a faithful preview of the real file;
   - "Open in Excel / Word";
   - "Ask for a change";
   - the previous runs' versions next to it, so last week can be compared with this week.

   The existing viewers (`app/src/components/artifacts/`) become read-only previews. Remove
   the editing.
6. **Connectors: few, and tested.** Don't try to beat opencode or Composio's own catalog.
   - Mark these as supported, with a scripted check that each one works: Gmail, Outlook,
     Google Calendar, Outlook Calendar, Sheets, Drive, OneDrive and Slack.
   - Label everything else "beta".
   - When a connector breaks, show the user a plain-language "reconnect Outlook" card instead
     of a tool error.
7. **The inbox as the record of every run.** Each scheduled run posts:
   - what it read;
   - what it changed;
   - what it is waiting to send;
   - the files it produced.

   Approving a pending email from the inbox should take one tap. This is the trust surface, so
   make it good.

8. **Plain-language activity.** The run log currently shows things like `Ran a command: cat -A
   expenses_q3_export.csv | head -20` and `Ran Python script clean_expenses.py`. The site's hero
   demo shows the same, because it copies the real app. Our user should see "Checked the export
   for broken rows" and "Cleaned up 412 transactions", with the command one click away. In the
   same pass, make the hero demo's report a `.docx` instead of `.md`, because that's the promise.

### P2: later, or cut

9. **Schedules that run when the laptop is closed**, through an optional cloud runner on paid
   plans. Cowork and ChatGPT both have a story for this, and it is the most common objection.
   Build it only after P0 and P1 are done.
10. **Cut from the main surface:**
   - the academic pipeline (move it to an optional skill pack);
   - the Telegram bot;
   - deploy;
   - the design and frontend skill packs (`frontend-toolkit`, `uiux-pro-max`,
     `awesome-design-md`).

   None of these serves the wedge, and all of them add tokens and confusion.

## Pricing

Keep $0, $12 and $50. $12 is the message. Rules that protect it:

- **Cost per active Pro user must stay under about $4 a month** in model spend. The P0 prompt
  trim and routing cheap models for the routine steps are what make this possible. Measure it
  before launch marketing.
- **Free stays genuinely useful** (3 schedules, one at a time). Free is our acquisition channel
  against the $20 incumbents.
- **Say it plainly:** "Less than ChatGPT Plus." Don't name exact competitor prices on the site.
  They change.

## Metrics that tell us whether it's working

| Metric | Definition | Target |
|---|---|---|
| Activation | A scheduled job saved in the first session | ≥ 40% of installs |
| Week-2 retention | A scheduled job ran ≥ 2 times and the user opened at least one result | ≥ 25% of installs |
| Acceptance | Delivered files opened without a follow-up "fix this" message | ≥ 80% |
| Unit cost | Model spend per active Pro user per month | < $4 |
| Conversion | Free users who hit the 3-schedule or one-at-a-time limit and upgrade | Track from day one |

If activation is high and week-2 retention is low, the jobs don't work well enough: go back to P0.
If activation is low, onboarding is the problem: fix the templates.

## What this changes in the repo

- `docs/PRODUCT.md`: target user corrected (non-technical, price-sensitive office workers).
- `LANDING_PAGE_BRIEF.md`: core-insight line replaced with the positioning above.
- `site/`: hero, page title, statement, capability card, ticker and the ChatGPT FAQ answer rewritten to match.
- Roadmap: the "V1 Artifact Workspace" phases are replaced by P0 and P1 above. Mark the editors
  as not planned in the next roadmap pass.
