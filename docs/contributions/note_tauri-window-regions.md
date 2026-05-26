# Design and Architecture Note: Tauri Window Regions

macOS window drag region configuration details and how we prevent duplicate drag strips on Windows layouts.

## Implementation Context
- **System Area**: zWork Backend & Desktop Shell
- **Key Files/Modules**: `sidecar/`, `app/src/`
- **Purpose**: Document design constraints, structures, and integration details.

## Details
This note provides guidelines and documentation on the handling of `Tauri Window Regions` in zWork.
Ensure that any future refactoring of related modules preserves this behavior and conforms to [design.md](file:///home/zemul/Programming/zWork/design.md).
