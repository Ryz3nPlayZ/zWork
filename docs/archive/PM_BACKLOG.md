# zWork PM Backlog

This backlog is based on the current repo state and product docs as of May 2026.

## Product Positioning

zWork should be judged as a desktop work agent, not a general chatbot.

The near-term promise is:

- install cleanly
- sign in cleanly
- complete a real desktop task cleanly
- produce a usable artifact
- preserve or export the result
- update cleanly

The product should avoid shipping generic AI features unless they are packaged as a clear job-to-be-done with a concrete output.

## Current Reality

What exists:

- desktop React/Tauri app shell
- local Python FastAPI sidecar
- persisted chat history
- model/provider settings
- Google/desktop auth path
- analytics and managed-mode surfaces
- in-app updater path
- client-side artifact extraction and right-side artifact panel
- viewers for doc, sheet, graph, preview, code, and diff artifacts
- basic sheet editing in component state
- project/context and memory surfaces
- local backend security tests
- cloud API with auth, analytics, coupon, and gateway logic

What is not yet product-complete:

- artifacts are not first-class persisted records with CRUD APIs
- artifact edits do not round-trip through backend storage
- graph generation is not a reliable backend workflow
- tasks/calendar do not exist as a product surface
- chat-to-task and chat-to-calendar wiring does not exist
- use-case demos are not yet hardened end to end
- cloud API tests remain thin
- duplicate `cloud/` and `cloud-src/` trees create drift risk
- release validation still depends on manual discipline

## P0: Do Before Any User-Test Release

1. Fix sign-in surface truthfulness.
   The current `LoginScreen` includes email/password fields that do not authenticate. Either remove/disable them or implement real email auth. Do not ship fake auth affordances.

2. Restore full automated test confidence.
   `npm run build` passes after cleanup. `cargo check` passes with warnings. `python3 -m pytest -q` needs `ZWORK_HOME=/tmp/...` in sandbox and currently has one failing model-list regression around legacy Ollama/cloud settings.

3. Define and run the release smoke matrix.
   Required flows: install, launch, sign in, onboarding, add model or activate managed mode, send first prompt, create artifact, reopen chat, update check, logout/relogin.

4. Resolve source-of-truth drift.
   Decide whether `cloud-src/` is the only cloud source. If yes, archive or remove `cloud/`; if no, add sync rules and tests.

5. Protect the five-minute test.
   A new user should produce one useful output within 3 minutes from first launch. Every onboarding/auth/settings decision should be judged against this.

## P1: V1 Artifact Workspace

Goal: turn chat outputs into durable work objects.

Build:

- artifact metadata model: id, kind, title, created/updated timestamps, source chat/message, version
- local artifact store under `ZWORK_HOME`, preferably SQLite plus blob files
- backend artifact CRUD endpoints
- frontend artifact API client
- load artifacts when reopening chats
- save title/content/sheet edits through backend
- export for doc markdown/text and sheet CSV
- regression tests for create, list, load, update, delete

Acceptance:

- a chat response creates an artifact
- the artifact opens in the panel immediately
- edits persist after app restart
- reopened chats retain artifact links
- artifacts are clearly separate from plain chat text

## P1: Sellable Demo Flows

Package only workflows that visibly beat browser ChatGPT.

Prioritize:

- meeting notes to summary, action list, and follow-up draft
- competitor research to comparison sheet
- CSV cleanup to editable sheet
- repo review to implementation plan
- downloads folder cleanup with preview and approval

Each demo needs:

- one-sentence prompt
- expected output artifact
- known setup requirements
- telemetry event for start, success, failure, and time-to-output
- repeatable manual test script

## P2: Task And Calendar Surface

Goal: follow-through, not a project-management suite.

Build:

- task model: title, note, status, priority, due date, source chat/artifact
- backend task CRUD endpoints
- compact Today/Upcoming surface
- lightweight status columns: Inbox, Todo, Doing, Done
- one-line natural-language task capture
- chat action to create a task from a response

Do not build:

- full calendar sync in V1
- enterprise permissions
- heavy kanban
- complex recurring scheduling

## P2: Graph Artifacts

Build graph artifacts only after artifact persistence exists.

Minimum:

- source data preserved
- recipe/source code preserved
- rendered preview
- export image
- rerun/regenerate path

Prefer Python-backed generation with `matplotlib` first. Add interactive graphs only after static charts work reliably.

## P2: Reliability And Observability

Add product-level instrumentation:

- install-to-first-launch
- sign-in started/completed/failed
- onboarding completed/skipped
- first prompt sent
- first artifact created
- artifact edited/saved/exported
- task completed
- update detected/installed/failed

Add engineering gates:

- frontend build
- Python tests with isolated `ZWORK_HOME`
- Tauri `cargo check`
- cloud API `cargo check`
- cloud auth/gateway unit tests
- release artifact/signature validation

## P3: Later Bets

Only after V1 artifact/task loop is solid:

- provider/calendar sync
- email workflows
- Notion/Slack/Jira connectors
- workflow builder
- scheduled automations
- shared/team spaces
- enterprise controls

## Decision Rules

Use these to cut scope:

- If it does not produce a durable output, it is probably not V1.
- If it cannot be demoed from a fresh install, it is not ready to market.
- If it requires a long explanation, the workflow is not packaged enough.
- If it adds capability without a job-to-be-done, defer it.
- If it risks data loss, auth failure, or update failure, it blocks release.
