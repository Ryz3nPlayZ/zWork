# Design and Architecture Note: Browser/Computer Control Technology Selection

Primary decision record for dctl browser/computer-control integration technology.

## Implementation Context
- **System Area**: zWork Backend & Desktop Shell
- **Key Files/Modules**: `sidecar/`, `app/src/`
- **Purpose**: Document design constraints, structures, and integration details.

## Details
For THE-4, the primary approach for browser/computer control is **Playwright**.

| Option | Latency | Reliability | Cross-platform support | Cost |
|---|---|---|---|---|
| **Playwright (selected)** | Low for direct scripted actions; no extra remote model hop required | High for browser workflows via deterministic selectors, waits, and automation primitives | Strong for browser automation across macOS, Windows, Linux | Low tooling cost (open-source); no per-action API fee |
| Anthropic Computer Use API | Higher due to model-in-the-loop perception/planning per interaction | Medium; strong on flexible UI tasks but can drift on repeated exact interactions | Broad for remotely controlled desktop/browser sessions | Usage-based API cost can become significant with long sessions |
| browser-use library | Medium; wraps browser automation with LLM reasoning overhead | Medium; useful abstraction but less deterministic than direct Playwright control | Good for browser tasks where Chromium automation is acceptable | Library itself is low cost, but relies on model usage |
| OS-level accessibility APIs (macOS AX, Windows UIA) | Low per operation once implemented | Potentially high for native-app controls, but implementation variance is substantial | Weak as a single approach (different APIs per OS, no unified Linux equivalent) | No direct API fee, but high engineering/maintenance cost |

### Decision
- Use **Playwright as the default and primary implementation** for dctl browser-control integration.
- Keep OS-level accessibility APIs as a later, optional extension for native desktop controls where browser automation is insufficient.
- Keep model-driven computer-use approaches as fallback research paths, not the default execution path.

This note provides guidelines and documentation on the handling of `Browser/Computer Control Technology Selection` in zWork.
Ensure that any future refactoring of related modules preserves this behavior and conforms to [design.md](file:///home/zemul/Programming/zWork/design.md).
