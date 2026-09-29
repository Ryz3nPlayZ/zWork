"""The task prompt handed to the agent for each SWE-bench instance.

This is deliberately close to the standard prompt used by SWE-agent / Claude
Code / OpenCode on SWE-bench: wrap the raw ``problem_statement`` in a minimal
instruct-to-act frame, point the agent at ``/testbed``, and tell it not to
commit. Deviating here would make our numbers non-comparable to other harnesses
which all use a near-identical wrapper.
"""

from __future__ import annotations

from typing import Any

TASK_TEMPLATE = """\
You are a software engineer working on the repository at `/testbed`.

Your task is to resolve the following issue reported on the repository. First \
reproduce the issue, then locate and fix its root cause, then verify the fix \
with the project's test suite. Make a *minimal* change — do not refactor or \
reformat unrelated code.

The repository is checked out at the base commit, before any fix has been \
applied. The project's tests can be run from `/testbed`; some may currently be \
failing because of the issue.

When you are done, leave your changes applied in the working tree. Do NOT \
commit, push, or open a pull request — the harness will collect the diff.

<issue>
{problem_statement}
</issue>
"""


def build_task_prompt(instance: dict[str, Any]) -> str:
    return TASK_TEMPLATE.format(
        problem_statement=instance.get("problem_statement", "").strip()
    )
