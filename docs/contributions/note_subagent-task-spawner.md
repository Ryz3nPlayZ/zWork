# Design and Architecture Note: Subagent Task Spawner

Spawn agent tool mechanics, subagent progress streaming, and SSE delta payload communication.

## Implementation Context
- **System Area**: zWork Backend & Desktop Shell
- **Key Files/Modules**: `sidecar/`, `app/src/`
- **Purpose**: Document design constraints, structures, and integration details.

## Details
This note provides guidelines and documentation on the handling of `Subagent Task Spawner` in zWork.
Ensure that any future refactoring of related modules preserves this behavior and conforms to [design.md](file:///home/zemul/Programming/zWork/design.md).
