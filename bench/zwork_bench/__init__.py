"""zWork SWE-bench Verified harness.

Drives the zWork Rust sidecar (`rwork-backend`) inside official SWE-bench
containers and grades the result with the standard FAIL_TO_PASS / PASS_TO_PASS
harness, producing a resolved-rate comparable to published numbers from Claude
Code, OpenCode, Aider, etc.

See README.md for usage, cost, and methodology.
"""

__version__ = "0.1.0"
