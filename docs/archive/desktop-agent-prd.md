# PRD: Desktop AI Assistant (Chat + Computer Actions)
**Working name:** Sidecar  
**Platforms:** macOS (v1)  
**Doc type:** Product Requirements Document (PRD)  
**Status:** Draft v0.1  
**Owner:** (TBD)  
**Last updated:** 2026-04-21  

---

## 1) Summary
Sidecar is a desktop app that feels like a chat with an AI, but can also *do things on your computer*—with clear permissions, previews, and an action log. Users describe outcomes in natural language (“organize these files”, “submit this form”, “draft and send this email”), and Sidecar plans and executes steps across apps and the OS while keeping users in control.

**MVP principle:** Make it feel simple: chat → plan → approve → done.  

---

## 2) Problem & Opportunity
### Problem
People waste time on repetitive “computer glue work”:
- moving/renaming files and organizing folders
- copying data between apps (browser → spreadsheet → email)
- filling forms and submitting content
- writing and rewriting messages with context from open tabs/documents

Existing AI chat apps can advise, but they cannot reliably *complete* the work in the user’s environment. Automation tools exist, but they require setup, scripting, or brittle rules.

### Opportunity
Deliver an assistant that:
- operates directly in the user’s existing tools (Finder, browser, Mail, Slack, Sheets, etc.)
- is safer and more transparent than generic automation
- turns successful work into reusable “workflows” without requiring programming

---

## 3) Goals / Non-goals
### Goals (v1)
1. **Chat-first UX** that feels like messaging an assistant.
2. **Computer actions**: the assistant can operate in the browser and file system and perform basic cross-app tasks.
3. **Trust & safety by default**: scoped permissions, previews for destructive actions, and an auditable action log.
4. **Repeatability**: turn a completed task into a reusable workflow/macro.
5. **“Not too complicated”**: minimize configuration and jargon; sensible defaults.

### Non-goals (v1)
- Full autonomous “run all day” agent without user oversight.
- Deep IDE replacement (developers can be users, but not the primary product shape).
- Advanced enterprise admin (SSO, org policy controls) unless needed for early pilots.
- Guaranteeing integration with *every* app; start with OS + browser + a few high-leverage targets.

---

## 4) Target Users & Use Cases
### Target segment
**Everyone** (broad usefulness), with a bias toward users who spend significant time in front of a computer and have recurring tasks.

### Primary jobs-to-be-done
1. **File organization & cleanup**
   - “Rename these files based on their contents.”
   - “Move all invoices from Downloads into a 2026/Invoices folder, organized by vendor.”
2. **Browser research → output**
   - “Summarize these 5 tabs into a 1-page brief and save it.”
   - “Compare these products and put the pros/cons into a table.”
3. **Form filling / submission assistance**
   - “Fill this application with the info in this PDF, then stop before submitting.”
4. **Cross-app clerical work**
   - “Take these meeting notes and create a follow-up email draft.”
   - “Extract tracking numbers from this page and paste into my spreadsheet.”

---

## 5) Product Principles (UX + Trust)
1. **Outcome-first conversation**: user states intent; system asks minimal clarifying questions.
2. **Plan before action**: always show a short plan and what will be touched (apps, files, pages).
3. **Progress you can understand**: step-by-step action queue with human-readable labels.
4. **Safe by default**: destructive actions require explicit confirmation and previews.
5. **Easy escape hatches**: pause, stop, undo (where possible), and “take over” instantly.
6. **Make success repeatable**: after completing a task, offer “Save as workflow”.

---

## 6) Core User Experience
### Primary surface: “Chat + Sidecar”
- A chat window/panel that behaves like a messaging app.
- A persistent **Action Queue** panel showing:
  - planned steps (pending)
  - currently executing step (in progress)
  - completed steps (with timestamps)
  - “View details” (what changed, what was clicked/typed)

### Modes
1. **Assist Mode (default)**
   - User approves key actions (especially sensitive/destructive).
2. **Autopilot for workflows (opt-in)**
   - For saved workflows in trusted folders/apps, allow execution with fewer prompts.

### Key UI components
- **Chat thread** (messages, attachments, links)
- **Plan card** (summary plan, impacted resources)
- **Permission prompt** (Allow once / Allow for session / Always allow for this folder/app)
- **Action Queue** (step list + status)
- **Artifacts drawer** (outputs: docs, tables, summaries, scripts; versioned)
- **Activity Log** (audit trail; exportable)

---

## 7) Core Flows (MVP)
### Flow A: File cleanup in a folder
1. User: “Clean up my Downloads: group screenshots by month and move invoices into an Invoices folder.”
2. Sidecar: asks clarifying question if needed (e.g., confirm target folders).
3. Sidecar: shows plan + preview of changes (moves/renames).
4. User approves.
5. Sidecar executes; Action Queue updates.
6. Sidecar summarizes results + offers “Undo” (where possible) + “Save as workflow”.

### Flow B: Summarize open tabs into a doc
1. User: “Summarize my open tabs about X into a 1-page brief.”
2. Sidecar: identifies tabs/sources to use; asks user to confirm selection if ambiguous.
3. Sidecar: drafts brief artifact; user reviews in-app.
4. User: “Export to Markdown / PDF / email.”

### Flow C: Form filling with a “stop before submit”
1. User: “Fill out this web form using the details in this PDF.”
2. Sidecar: requests permission for the browser tab + reads PDF.
3. Sidecar: fills fields; highlights any uncertain fields.
4. Sidecar stops at the final step: “Ready to submit—approve?”

---

## 8) Functional Requirements
### 8.1 Conversation & Intent
- Natural language task entry with attachments (files, screenshots, copied text).
- Minimal clarifying questions; when asked, options are concrete.
- Ability to reference context: “use the last email draft”, “use the file we created earlier”.

### 8.2 Computer Actions (v1 scope)
**File system (Finder / local folders)**
- List, search, move, copy, rename, create folders
- Basic content-based operations where feasible (e.g., by filename patterns; optional OCR for images later)
- Preview/diff for rename/move operations

**Browser (Safari/Chrome, initial support TBD)**
- Read page content (visible text + structured extraction when possible)
- Click, type, select, scroll
- Tab awareness: list tabs, choose which to use
- “Stop before submit” guard for forms

**Text generation + editing**
- Create artifacts: Markdown notes, briefs, tables, email drafts
- Inline edit instructions: “shorten”, “make more formal”, “add bullets”

### 8.3 Workflows (lightweight automation)
- “Save as workflow” after any successful run
- Workflow includes:
  - a name + short description
  - required inputs (variables) with prompts
  - permissions scope (folders/apps/sites)
  - run history
- Workflow runs can be launched from:
  - a workflow library screen
  - a command palette / global hotkey (optional)

---

## 9) Safety, Permissions, and Trust Requirements
### Permission scopes
- Folder-scoped access (e.g., “Downloads only”)
- Site/tab-scoped access (e.g., “this domain only”)
- Time-scoped access (e.g., “allow for 15 minutes”)

### Risk categories (for prompting)
- **Safe:** reading content, drafting text, non-destructive navigation
- **Sensitive:** sending messages, editing existing docs, accessing personal folders
- **Destructive:** delete/overwrite, bulk renames/moves without preview

### Guardrails
- Always require confirmation for:
  - Delete actions
  - Sending messages/emails (unless in explicit trusted workflow)
  - Final form submission (default on)
- Bulk file operations must show a preview list with counts and a “download/export plan” option.
- Provide a visible **Pause / Stop** button during execution.

### Auditability
- Persist an activity log of:
  - tasks requested
  - plan shown
  - approvals granted (scope + time)
  - actions executed (high-level; avoid storing sensitive raw content by default)
- Exportable run report (for troubleshooting and trust).

---

## 10) Data, Privacy, and Storage
### Data handling defaults
- Store minimal necessary data for product functionality.
- Outputs/artifacts saved locally by default (with clear user control).

### “Private zones” (v1 or v1.1)
- User can mark apps/folders as:
  - never accessible
  - accessible only with explicit per-action approval

### Telemetry (opt-in preferred)
- Basic usage analytics: feature usage, workflow success/failure, latency
- No collection of document/page contents without explicit opt-in

---

## 11) Technical Overview (high level)
### Architecture sketch
- Desktop app shell (macOS-first; likely cross-platform framework later)
- Core components:
  1. **Conversation + Orchestrator**: turns user intent into a plan of steps
  2. **Permission Manager**: enforces scopes and prompts
  3. **Action Executor**: performs OS + browser actions with checkpoints
  4. **Artifact Manager**: stores generated outputs and versions
  5. **Activity Log**: auditable record of actions and approvals

### Reliability requirements
- Detect failures and recover gracefully:
  - if UI changes, ask user to confirm the target element
  - if ambiguous, present choices rather than guessing
- Always report what succeeded/failed and what remains.

---

## 12) Success Metrics
### North-star metrics
- **Task completion rate**: % of sessions where the user’s task reaches a satisfactory “done”
- **Time saved** (self-reported or estimated from action logs)

### Supporting metrics
- Median time-to-first-action
- % tasks that require clarifying questions
- Workflow save rate and workflow reuse rate
- Safety: number of prevented risky actions (e.g., “stopped before submit” used)
- Retention: weekly active users, repeat sessions per week

---

## 13) MVP Scope Checklist
### Must-have (ship)
- Chat UI with attachments
- Plan card + Action Queue
- Folder-scoped file operations (move/copy/rename + preview)
- Browser read + basic interact (click/type/scroll) for a single supported browser
- Stop-before-submit for forms
- Activity log + run history
- Save-as-workflow (simple variables + run)

### Nice-to-have (post-MVP)
- Global hotkey command bar
- Multi-app connectors (Mail, Calendar, Slack, Notion)
- Stronger undo (snapshots/versioning)
- OCR for screenshots/PDFs
- Scheduled workflows

---

## 14) Milestones (suggested)
1. **Prototype (2–4 weeks):** chat + action queue + scripted file ops in a demo folder
2. **Private alpha (4–8 weeks):** permissions + browser automation + logging
3. **Beta (8–12 weeks):** workflows + polish + reliability hardening
4. **v1 launch:** onboarding, safety review, analytics, support loop

---

## 15) Open Questions
1. Which browser to support first on macOS (Safari vs Chrome)?  
2. How strong should “undo” be for v1 (file snapshotting vs limited undo)?  
3. What are the first 3 “hero tasks” to optimize onboarding for?  
4. Should Sidecar run as a menu bar app, a dock app, or both?  
5. What is the default stance on sending messages/emails (always approve vs trusted workflows)?

