import { baseState, type Scenario } from "./engine";
import type { HistoryItem, InboxItem, Task } from "./types";

const HISTORY: HistoryItem[] = [
  { id: "h1", title: "Draft launch email to the beta list", bucket: "This week" },
  { id: "h2", title: "Compare vendor quotes for new laptops", bucket: "This week" },
  { id: "h3", title: "Turn interview notes into a deck", bucket: "This week" },
  { id: "h4", title: "Clean up the shared Drive folder", bucket: "Earlier" },
  { id: "h5", title: "Find 30 design agencies in Austin", bucket: "Earlier" },
  { id: "h6", title: "Reconcile Stripe payouts for August", bucket: "Earlier" },
];

const TASKS: Task[] = [
  { id: "t1", title: "Lead research", trigger: "Mondays at 9:00", next: "Mon 9:00", last: "6 days ago", enabled: true },
  { id: "t2", title: "Weekly update for the team", trigger: "Fridays at 16:00", next: "Fri 16:00", last: "3 days ago", enabled: true },
  { id: "t3", title: "Competitor price watch", trigger: "Every 4 hours", next: "in 2h", last: "2h ago", enabled: true, repeat: true },
  { id: "t4", title: "Clear out newsletter emails", trigger: "Daily at 7:00", next: "", enabled: false },
];

const INBOX: InboxItem[] = [
  {
    id: "i1",
    title: "Competitor price watch",
    kind: "summary",
    body: "No price changes since 10:00. Acme still lists Pro at $29.",
    time: "2h",
    read: true,
  },
  {
    id: "i2",
    title: "Weekly update for the team",
    kind: "summary",
    body: "Draft left in Gmail for you to review. 3 shipped, 2 in progress, 1 blocked on legal.",
    time: "3d",
    read: true,
  },
  {
    id: "i3",
    title: "Lead research",
    kind: "summary",
    body: "Added 30 companies to the Leads sheet. 8 have a named head of design.",
    time: "6d",
    read: true,
  },
];

/* ------------------------------------------------------------------ */
/* Hero: a messy bank export becomes a cleaned workbook and a report. */
/* ------------------------------------------------------------------ */

const EXPENSE_PROMPT =
  "Here's our Q3 bank export. It's a mess. Clean it up, categorize every transaction, and write a report I can send my cofounder.";

const EXPENSE_REPLY = `Done. Cleaned 87 raw rows down to 86 (one duplicate removed), normalized 3 date formats and 17 vendor-name variants, and categorized everything.

**Files:**

- \`outputs/q3_expenses_cleaned.xlsx\`: 3 sheets: *Cleaned Transactions*, *Summary*, and *Duplicates Removed* (the $51.38 Blue Bottle charge)
- \`outputs/q3_spending_report.md\`: the cofounder-ready writeup

**Headline numbers:** $43,687.78 total. Advertising (35%) and contractors (29%) are 64% of spend. July $18.4k → Aug $12.9k → Sep $12.4k.`;

export const heroScenario: Scenario = {
  initial: baseState({ history: HISTORY, tasks: TASKS, inbox: INBOX, model: "Claude Opus 5.5" }),
  // Paced for a page, not real time: quick typing, short tool steps, a fast
  // stream, and the report opens the moment the reply finishes.
  build: (s) => {
    const a = "a-hero";
    s.wait(0.4)
      .chapter("ask")
      .type(EXPENSE_PROMPT, 110)
      .wait(0.2)
      .send({ time: "5:21 PM", attachment: "expenses_q3_export.csv", title: "Here's our Q3 bank export. It's a mess. Cl…", historyId: "hero" })
      .chapter("work")
      .wait(0.35)
      .word(1)
      .assistant(a)
      .step(a, "Read expenses_q3_export.csv", "wrench", 0.4)
      .step(a, "Ran a command: wc -l expenses_q3_export.csv && head -5 expenses_q3_export.csv", "terminal", 0.35)
      .step(a, "Ran a command: cat -A expenses_q3_export.csv | head -20", "terminal", 0.3)
      .step(a, "Ran a Python snippet", "wrench", 0.4)
      .step(a, "Wrote clean_expenses.py", "wrench", 0.3)
      .step(a, "Ran Python script clean_expenses.py", "wrench", 0.45)
      .step(a, "Edited clean_expenses.py", "wrench", 0.25)
      .step(a, "Ran Python script clean_expenses.py", "wrench", 0.35)
      .step(a, "Wrote build_outputs.py", "code", 0.3)
      .step(a, "Wrote outputs/q3_expenses_cleaned.xlsx", "table", 0.3)
      .step(a, "Wrote outputs/q3_spending_report.md", "file", 0.3)
      .msg(a, { working: false, stepsOpen: false })
      .wait(0.1)
      .stream(a, EXPENSE_REPLY, 600)
      .msg(a, { artifact: { title: "Q3 2026 Spending Report", kind: "report" } })
      .do({ working: false, panel: { title: "Q3 2026 Spending Report", kind: "report", progress: 0 } })
      .msg(a, { footer: "5:24 PM ↑434.6k ↓12.2k · $0.0237" })
      .chapter("result")
      .write(1.3)
      .wait(4);
  },
};

/* ------------------------------------------------------------------ */
/* Schedules: set it up in plain words, run it, the result lands in Inbox. */
/* ------------------------------------------------------------------ */

const SCHEDULE_PROMPT =
  "Every weekday at 8:30, check Gmail for new invoices, add them to the Invoices sheet, and flag anything over $1,000.";

const SCHEDULE_REPLY = `Set. **Invoice check** runs every weekday at 8:30. Each run searches Gmail for new invoices, adds them to your Invoices sheet and flags anything over $1,000.

Results land in your Inbox. I'll run it once now so you can see what it sends.`;

const INVOICE_RESULT = `Found 3 new invoices and added them to the Invoices sheet (rows 41–43).

Over $1,000: Northwind Design, $2,400.00, due Oct 9.
Due this week: Hetzner €38.20 (Oct 7), Figma $45.00 (Oct 8).`;

export const scheduleScenario: Scenario = {
  initial: baseState({ history: HISTORY, tasks: TASKS, inbox: INBOX, model: "zWork Pro" }),
  build: (s) => {
    const a = "a-sched";
    s.wait(0.6)
      .chapter("ask")
      .type(SCHEDULE_PROMPT, 42)
      .wait(0.3)
      .send({ time: "9:12 AM", title: "Invoice check every weekday", historyId: "sched" })
      .wait(1.0)
      .assistant(a)
      .step(a, "Checked the Gmail connection", "mail", 0.8)
      .step(a, "Found the Invoices sheet in Google Drive", "table", 0.8)
      .step(a, "Created a schedule: weekdays at 8:30", "calendar", 0.9)
      .msg(a, { working: false, stepsOpen: false })
      .stream(a, SCHEDULE_REPLY, 150)
      .do((st) => ({
        working: false,
        tasks: [
          { id: "t0", title: "Invoice check", trigger: "Weekdays at 8:30", next: "tomorrow 8:30", enabled: true, isNew: true },
          ...st.tasks,
        ],
      }))
      .chapter("schedule")
      .wait(0.8)
      .showCursor({ x: 420, y: 640 })
      .moveTo("nav-scheduled", 0.9)
      .click("nav-scheduled")
      .do({ view: "scheduled" })
      .wait(0.7)
      .moveTo("run-t0", 0.8)
      .click("run-t0")
      .do((st) => ({ tasks: st.tasks.map((t) => (t.id === "t0" ? { ...t, running: true } : t)) }))
      .wait(2.6)
      .do((st) => ({
        tasks: st.tasks.map((t) => (t.id === "t0" ? { ...t, running: false, last: "just now" } : t)),
        inbox: [
          { id: "i0", title: "Invoice check", kind: "flag", body: INVOICE_RESULT, time: "now", read: false, isNew: true },
          ...st.inbox,
        ],
      }))
      .chapter("inbox")
      .wait(0.9)
      .moveTo("nav-inbox", 0.8)
      .click("nav-inbox")
      .do({ view: "inbox" })
      .wait(0.6)
      .moveTo("row-i0", 0.7)
      .click("row-i0")
      .do((st) => ({ inbox: st.inbox.map((i) => (i.id === "i0" ? { ...i, open: true } : i)) }))
      .wait(0.4)
      .hideCursor()
      .wait(4.5);
  },
};

/* ------------------------------------------------------------------ */
/* Approval: it drafts, you OK the send.                               */
/* ------------------------------------------------------------------ */

const APPROVAL_PROMPT = "Check Priya's Q3 numbers against our cleaned sheet and email her about anything that doesn't match.";

export const approvalScenario: Scenario = {
  initial: baseState({ history: HISTORY, tasks: TASKS, inbox: INBOX, model: "GPT-5.5" }),
  build: (s) => {
    const a = "a-appr";
    const b = "a-appr2";
    s.wait(0.6)
      .chapter("ask")
      .type(APPROVAL_PROMPT, 42)
      .wait(0.3)
      .send({ time: "2:40 PM", title: "Check Priya's Q3 numbers", historyId: "appr" })
      .wait(0.9)
      .assistant(a)
      .step(a, "Searched Gmail: from:priya Q3", "mail", 0.9)
      .step(a, "Read Q3_summary_northwind.pdf", "file", 0.9)
      .step(a, "Compared against outputs/q3_expenses_cleaned.xlsx", "table", 1.1)
      .step(a, "Drafted a reply to Priya", "mail", 0.8)
      .msg(a, { working: false, stepsOpen: false })
      .stream(
        a,
        "Two things don't match: Priya's copy still has the duplicate **$51.38 Blue Bottle** charge, and her contractor total is $412 lower because one Upwork invoice landed in October. I drafted a reply with the breakdown attached.",
        150,
      )
      .msg(a, { artifact: { title: "Reply to Priya", kind: "email" } })
      .do({ panel: { title: "Reply to Priya", kind: "email", progress: 0 } })
      .write(2.4)
      .chapter("ask-ok")
      .do({
        permission: {
          title: "Send email",
          reason: "Send an email from sam@acme.co to priya@northwind-accounting.com",
          detail: "Subject: Q3 expenses: one duplicate, contractor breakdown attached\nAttachment: q3_contractors_by_vendor.xlsx",
        },
      })
      .wait(1.6)
      .showCursor({ x: 360, y: 300 })
      .moveTo("allow", 1.0)
      .wait(0.3)
      .click("allow")
      .do({ permission: null, working: true })
      .hideCursor()
      .chapter("sent")
      .assistant(b)
      .step(b, "Sent email to priya@northwind-accounting.com", "mail", 1.0)
      .msg(b, { working: false, stepsOpen: true })
      .stream(b, "Sent. I'll leave the thread alone until she replies.", 120)
      .do({ working: false })
      .msg(b, { footer: "2:42 PM ↑88.1k ↓2.4k · $0.0061" })
      .wait(4.5);
  },
};

/* ------------------------------------------------------------------ */
/* Your model: the picker, cycling between hosted, your key, and local. */
/* ------------------------------------------------------------------ */

export const modelScenario: Scenario = {
  initial: baseState({ model: "zWork Pro", composer: "Summarize this week's support tickets by theme" }),
  build: (s) => {
    const pick = (id: string, name: string) =>
      s
        .moveTo("model", 0.7)
        .click("model")
        .do({ modelMenu: true })
        .wait(0.5)
        .moveTo(`model-${id}`, 0.8)
        .wait(0.25)
        .click(`model-${id}`)
        .do({ modelMenu: false, model: name })
        .wait(1.6);
    s.wait(0.4).showCursor({ x: 300, y: 330 });
    pick("claude", "Claude Opus 5.5");
    pick("local", "gpt-oss:120b");
    pick("deepseek", "DeepSeek V4 Pro");
    pick("zwork-pro", "zWork Pro");
  },
};

/* ------------------------------------------------------------------ */
/* Apps & browser: steps from a run that drives a site with no API.    */
/* ------------------------------------------------------------------ */

export const browserScenario: Scenario = {
  initial: baseState({
    view: "chat",
    working: true,
    messages: [],
  }),
  build: (s) => {
    const a = "a-web";
    s.wait(0.3)
      .assistant(a)
      .step(a, "Opened portal.hetzner.com in the browser", "globe", 0.9)
      .step(a, "Clicked “Invoices”", "pointer", 0.7)
      .step(a, "Read the invoice table", "search", 0.8)
      .step(a, "Clicked “Download PDF” on INV-20931", "pointer", 0.8)
      .step(a, "Opened Numbers and pasted 3 rows", "pointer", 1.0)
      .step(a, "Saved Hosting costs 2026.numbers", "file", 0.8)
      .msg(a, { working: false })
      .wait(3);
  },
};
