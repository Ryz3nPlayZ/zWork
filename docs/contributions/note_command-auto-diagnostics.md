# Design and Architecture Note: Command Auto-Diagnostics

Diagnostic heuristics used by _diagnose_command_failure to detect and repair common command issues.

## Implementation Context
- **System Area**: zWork Backend & Desktop Shell
- **Key Files/Modules**: `sidecar/`, `app/src/`
- **Purpose**: Document design constraints, structures, and integration details.

## Details
This note provides guidelines and documentation on the handling of `Command Auto-Diagnostics` in zWork.
Ensure that any future refactoring of related modules preserves this behavior and conforms to [design.md](file:///home/zemul/Programming/zWork/design.md).
