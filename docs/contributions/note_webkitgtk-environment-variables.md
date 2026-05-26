# Design and Architecture Note: WebKitGTK Environment Variables

WebKitGTK environment variables configurations used to prevent relaunch process spawn crashes on Linux.

## Implementation Context
- **System Area**: zWork Backend & Desktop Shell
- **Key Files/Modules**: `sidecar/`, `app/src/`
- **Purpose**: Document design constraints, structures, and integration details.

## Details
This note provides guidelines and documentation on the handling of `WebKitGTK Environment Variables` in zWork.
Ensure that any future refactoring of related modules preserves this behavior and conforms to [design.md](file:///home/zemul/Programming/zWork/design.md).
