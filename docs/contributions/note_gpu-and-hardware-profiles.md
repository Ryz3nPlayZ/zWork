# Design and Architecture Note: GPU and Hardware Profiles

NVIDIA CUDA and macOS Apple Silicon MPS capabilities detection logic in detect_hardware.

## Implementation Context
- **System Area**: zWork Backend & Desktop Shell
- **Key Files/Modules**: `sidecar/`, `app/src/`
- **Purpose**: Document design constraints, structures, and integration details.

## Details
This note provides guidelines and documentation on the handling of `GPU and Hardware Profiles` in zWork.
Ensure that any future refactoring of related modules preserves this behavior and conforms to [design.md](file:///home/zemul/Programming/zWork/design.md).
