# Design and Architecture Note: SQLite Task and Event Model

SQLite and local JSON storage structures for tracking Kanban board tasks and calendar daily events.

## Implementation Context
- **System Area**: zWork Backend & Desktop Shell
- **Key Files/Modules**: `sidecar/`, `app/src/`
- **Purpose**: Document design constraints, structures, and integration details.

## Details
This note provides guidelines and documentation on the handling of `SQLite Task and Event Model` in zWork.
Ensure that any future refactoring of related modules preserves this behavior and conforms to [design.md](file:///home/zemul/Programming/zWork/design.md).
