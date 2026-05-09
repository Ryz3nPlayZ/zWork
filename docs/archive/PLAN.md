# zWork V1 Plan: Artifact Workspace + Task/Calendar Surface

## Goal
Turn chat into a real work surface that can produce, edit, and organize deliverables inside the app.

This phase adds two product pillars:

1. An in-chat artifact viewer/editor for docs, sheets, tables, code, and graphs.
2. A compact, aesthetically consistent task + calendar surface for tracking what needs to happen next.

The outcome should support the most sellable non-technical workflows:

- meeting notes to follow-up tasks
- research to brief/doc
- CSV cleanup to editable sheet
- charts and summaries to shareable artifacts
- day planning with a small todo + calendar cockpit

## Product Thesis
zWork should not feel like “chat that can talk about work.” It should feel like “chat that can produce the work.”

The UX rule for this phase:

- chat is the entry point
- artifacts are the outputs
- tasks and calendar are the follow-through

## UX Principles to Preserve

Research-backed patterns to keep the surface usable:

- Keep Kanban lightweight and visible. Limit work in progress so the `Doing` column does not become a backlog graveyard.
- Keep calendar navigation fast. Users should always have a clear `Today`, `Week`, and `Month` path plus a mini date navigator.
- Keep task capture keyboard-first. A fast natural-language add flow is more valuable than a complicated form.
- Keep the default planning view curated. Show what matters now, not a giant project management interface.
- Keep artifact editing embedded in the app. Users should not have to export to another app to inspect or tweak the result.

## Current Baseline

The repo already has some of the building blocks:

- chat UI and message/activity rendering in `app/src/components/ChatView.tsx` and `app/src/components/Message.tsx`
- backend artifact scaffolding in `sidecar/core/artifacts.py`
- execution and activity logging in `sidecar/core/executor.py` and `sidecar/core/activity_log.py`
- project/context storage in `sidecar/agent/projects.py`
- app state in `app/src/lib/store.ts`

What is missing:

- a first-class artifact viewer in chat
- native doc and sheet editors
- graph artifact rendering
- a task system with a clean visual language
- a compact calendar view that matches the task surface
- wiring from chat output into artifacts and tasks

## Scope

### In scope

- artifact types: `doc`, `sheet`, `graph`, `table`, `code`
- inline artifact creation from chat
- native in-app viewing and editing for docs and sheets
- Python-backed graph generation and preview
- a small task list / mini kanban with WIP awareness
- a compact calendar strip or agenda surface
- chat actions that create tasks, calendar entries, and artifacts

### Out of scope for this phase

- Google Workspace sync
- full collaboration / multi-user editing
- enterprise permissions or org-level admin controls
- full spreadsheet formula compatibility
- full calendar provider sync
- a deep project-management suite

## Information Architecture

The app should support three main working modes:

1. Chat
2. Artifacts
3. Tasks / Calendar

Recommended structure:

- Chat remains the primary surface.
- Artifacts appear as a right-side viewer or split pane when an artifact is selected.
- Tasks and calendar live in a compact side rail or lower dock, not as a separate heavy app section.

## Phase Breakdown

### Phase 1. Artifact Foundation

Build the storage and data model needed for editable artifacts.

#### Deliverables

- artifact metadata model with stable IDs, type, title, timestamps, and source message linkage
- artifact storage in `~/.zwork/` runtime state
- APIs for creating, listing, loading, updating, and deleting artifacts
- a default artifact rail in chat

#### Implementation targets

- `sidecar/core/models.py`
- `sidecar/core/artifacts.py`
- `sidecar/server.py`
- `app/src/lib/api.ts`
- `app/src/lib/store.ts`
- `app/src/components/ChatView.tsx`
- `app/src/components/Message.tsx`

#### Acceptance criteria

- A chat response can create an artifact and immediately surface it in the UI.
- Artifacts persist across app restarts.
- Selecting an artifact loads it in a consistent viewer shell.
- The UI shows artifact type clearly and does not conflate it with plain chat messages.

#### Risks

- artifact data model too narrow
- UI coupling to a single document format
- poor separation between generated content and editable content

---

### Phase 2. Native Doc and Sheet Editors

Add in-app editing for the two most sellable artifact types: documents and spreadsheets.

#### Docs

Start with a practical editor, not a full word processor.

Minimum viable behavior:

- title + body editing
- markdown-friendly formatting
- section headings, bullets, bold, links
- export to markdown and plain text
- revision history for recent changes

#### Sheets

Start with a compact data grid, not full Excel parity.

Minimum viable behavior:

- rows and columns
- editable cells
- add/remove rows and columns
- sort/filter basic columns
- copy/paste table data
- import from CSV-like tabular output
- export to CSV

#### Implementation targets

- `app/src/components/ArtifactViewer.tsx` or equivalent new artifact shell
- `app/src/components/DocEditor.tsx`
- `app/src/components/SheetEditor.tsx`
- `app/src/lib/api.ts`
- `sidecar/core/artifacts.py`
- `sidecar/server.py`

#### Acceptance criteria

- a doc artifact can be edited in-place and saved
- a sheet artifact can be edited cell-by-cell and saved
- changes persist and can be reopened later
- the editor feels native to the app, not embedded as a generic third-party widget

#### Risks

- overbuilding formatting controls too early
- spreadsheet semantics getting too ambitious
- usability problems if text selection and keyboard navigation are weak

---

### Phase 3. Graph Artifacts

Make charting a first-class artifact type so users can turn analysis into something visual.

#### Deliverables

- graph artifact type
- Python script or notebook-style backing for graph generation
- rendered preview inside the app
- source code view for the graph recipe
- re-run / regenerate flow

#### Recommended approach

Use Python graph libraries rather than building custom chart rendering.

Good defaults:

- `matplotlib` for static charts
- `plotly` only if interactive graphs are needed later

#### Implementation targets

- `sidecar/core/artifacts.py`
- `sidecar/core/executor.py`
- `sidecar/server.py`
- artifact viewer component

#### Acceptance criteria

- the assistant can create a graph artifact from data in chat
- the graph has both a visual preview and a source definition
- the user can inspect or tweak the graph inputs
- the graph artifact can be exported as an image or embedded preview

#### Risks

- inconsistent rendering between systems
- too much custom plotting logic
- poor provenance if the source data is not preserved

---

### Phase 4. Mini Todo + Calendar Surface

Add a compact personal planning surface that matches the product’s visual tone.

#### Recommended UX shape

- default view: `Today`
- secondary views: `Upcoming`, `Board`, `Month`
- task creation: one-line quick add
- task movement: drag/drop between status and date
- calendar navigation: small month navigator + `Today` button
- visible `Doing` WIP limit

#### Task model

Use a simple, legible task schema:

- title
- optional note
- due date
- status: `Inbox`, `Todo`, `Doing`, `Done`
- priority
- optional link to an artifact, chat, or project

#### Board behavior

- keep columns few and explicit
- visually limit the `Doing` column
- show blocked items clearly
- show what was added from chat

#### Calendar behavior

- agenda-first list for the next few days
- quick jump to date with mini month navigator
- basic day/week/month toggle
- tasks can be assigned a date without turning into a full calendar product

#### Implementation targets

- new task model in `sidecar/core/models.py` or a dedicated task module
- storage and APIs in `sidecar/server.py`
- app state in `app/src/lib/store.ts`
- new UI components in `app/src/components/`

#### Acceptance criteria

- user can add a task in one sentence
- user can move tasks through a simple workflow
- user can see what is due today and what is coming next
- the calendar is calm and readable, not a dense enterprise planner

#### Risks

- turning the task surface into a bloated project manager
- too much screen chrome around a small planning feature
- calendar sync assumptions leaking into v1

---

### Phase 5. Chat-to-Artifact and Chat-to-Task Wiring

This is the feature that makes the app feel like a work product rather than a note-taking app.

#### Deliverables

- chat actions that create doc, sheet, and graph artifacts
- chat actions that create tasks and calendar items
- artifact references in messages
- task references in messages
- suggested follow-up actions after a response

#### Example flows

- “Summarize these meeting notes” creates a doc artifact and tasks
- “Make a table of these companies” creates a sheet artifact
- “Plot monthly revenue from this CSV” creates a graph artifact
- “Remind me to follow up Friday” creates a task

#### Acceptance criteria

- at least one artifact or task can be created directly from a chat turn
- the user can click from chat into the resulting artifact
- follow-up actions are obvious and low friction

---

### Phase 6. Sellable Use Cases

Package the experience into concrete demos that a non-technical user can understand.

#### Demo flows to prioritize

- meeting notes to action list
- research tabs to one-page brief
- CSV cleanup to clean sheet
- invoice/doc organization
- chart from pasted data
- daily planning with tasks + calendar

#### Acceptance criteria

- each demo can be completed in one or two user prompts
- each demo produces a visible artifact
- each demo has a useful next step

## Recommended File Targets

Likely files to add or change:

- `docs/archive/PLAN.md`
- `sidecar/core/models.py`
- `sidecar/core/artifacts.py`
- `sidecar/server.py`
- `sidecar/core/executor.py`
- `app/src/lib/api.ts`
- `app/src/lib/store.ts`
- `app/src/components/ChatView.tsx`
- `app/src/components/Message.tsx`
- `app/src/components/Sidebar.tsx`
- `app/src/components/Settings.tsx`
- new artifact editor/viewer components under `app/src/components/`

## Design Constraints

- Keep the visual language consistent with the existing warm, editorial style.
- Avoid generic SaaS blue dashboard patterns.
- Prefer compact, readable surfaces over dense control panels.
- Keep keyboard shortcuts strong.
- Make sure mobile and narrow desktop widths still work.

## Non-Goals for the UI

- no giant kanban board by default
- no enterprise calendar grid packed with features
- no separate artifact app
- no hidden complexity that only power users can unlock

## Verification Plan

The phase should be considered done only when these checks pass:

- artifacts can be created, reopened, and edited
- docs and sheets persist data correctly
- graph artifacts render from real data
- tasks can be added and moved between states
- calendar view shows today/upcoming clearly
- chat can create and link to artifacts
- the app still builds cleanly

### Suggested test coverage

- backend tests for artifact CRUD
- backend tests for task CRUD
- backend tests for graph generation path
- UI tests for artifact selection and editor save flow
- UI tests for quick-add task creation
- regression test for chat state loading with artifacts

## Success Criteria

By the end of this plan, zWork should be able to say:

- I can chat to produce a document
- I can chat to produce a table or sheet
- I can inspect and edit the result inside the app
- I can turn a message or note into a task
- I can see what’s due today without leaving the app
- I can generate a graph and trust where it came from

## Notes

This phase is intentionally focused on functional value over broad integration.
It is the shortest path to a credible v1 that can be shown to non-technical users
without relying on code-first behavior.
