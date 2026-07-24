# Tasks — backlog

Status: **deferred for reimplementation.**

The Tasks surface (kanban board, list view, calendar) is currently unreachable
from the sidebar. The sidebar button is intentionally commented out — see
`app/src/components/Sidebar.tsx` (search "Tasks (kanban)").

## What exists today

The implementation is complete and functional, just not exposed:

- **Frontend** — `app/src/components/tasks/`
  - `TasksPage.tsx` — board / list / calendar views
  - `NewTaskModal.tsx` — create + edit
  - `CalendarView.tsx` — month/week/day with task pills + events
- **Store** — `app/src/lib/store.ts`
  - `fetchTasks`, `addTask`, `updateTask`, `updateTaskColumn`, `deleteTask`,
    `fetchEvents`
- **Backend** — `sidecar-rust/src/taskstore.rs` (file-backed JSON CRUD) +
  routes at `sidecar-rust/src/server.rs` (`/api/tasks`, `/api/tasks/:id`,
  `/api/tasks/:id/column`).
- **Route** — `view === "tasks"` still resolves in `app/src/App.tsx`, so the
  page renders if `setView("tasks")` is called directly. Only the nav entry
  is hidden.

No TODO/FIXME/stub markers in any of the above — the code is production-shaped.

## Why it's backlog

The UX is being redesigned. Rather than ship the current kanban-first layout
and then churn it, the nav entry stays hidden until the redesign lands.

## Plan

Reimplement against the new UX (TBD). The store actions and backend are
likely to be reused as-is; the frontend components are the likely rewrite
surface. When the redesign is ready:

1. Update or replace `app/src/components/tasks/*`.
2. Uncomment the `<SidebarButton label="Tasks" ...>` block in `Sidebar.tsx`.
3. If the data model changes, migrate `taskstore.rs` and the store actions
   together.
