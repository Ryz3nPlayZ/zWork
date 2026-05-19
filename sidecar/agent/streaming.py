"""Streaming progress tracking for long-running tools.

Provides MilestoneTracker for emitting meaningful progress updates
instead of streaming every line of output.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from dataclasses import dataclass, field
from typing import AsyncIterator


@dataclass
class Milestone:
    """A progress milestone for a long-running operation."""
    label: str
    fraction: float  # 0.0 to 1.0
    emit: bool = True  # Whether to emit this milestone to the UI


@dataclass
class StreamedTool:
    """Base class for tools that emit streaming progress."""
    tool_id: str
    label: str
    icon: str = "tool"
    started_at: float = field(default_factory=lambda: time.monotonic())
    last_emit: float = 0.0
    emit_interval: float = 0.3  # Minimum seconds between emits

    def should_emit(self) -> bool:
        """Check if enough time has passed to emit another update."""
        now = time.monotonic()
        if now - self.last_emit >= self.emit_interval:
            self.last_emit = now
            return True
        return False

    def initial_event(self) -> dict:
        """Emit the initial activity event."""
        return {
            "type": "activity",
            "id": self.tool_id,
            "label": self.label,
            "icon": self.icon,
            "done": False,
        }

    def progress_event(self, label: str) -> dict:
        """Emit a progress update event."""
        return {
            "type": "tool_progress",
            "tool_id": self.tool_id,
            "label": label,
        }


class MilestoneTracker(StreamedTool):
    """Tracks progress through a series of milestones for a tool."""

    def __init__(
        self,
        tool_id: str,
        label: str,
        milestones: list[Milestone],
        icon: str = "tool",
    ):
        super().__init__(tool_id, label, icon)
        self.milestones = milestones
        self.current_index = 0
        self.current_milestone: Milestone | None = None

    async def iter(self) -> AsyncIterator[dict]:
        """Iterate through milestones, yielding progress events."""
        yield self.initial_event()

        for milestone in self.milestones:
            self.current_milestone = milestone
            self.current_index = self.milestones.index(milestone)

            if milestone.emit and self.should_emit():
                yield self.progress_event(
                    f"{self.label}: {milestone.label}"
                )

            # Yield control back to the event loop
            await asyncio.sleep(0)

        # Final completion event
        yield self.progress_event(f"{self.label}: Complete")
        yield {
            "type": "activity",
            "id": self.tool_id,
            "label": self.label,
            "icon": self.icon,
            "done": True,
        }

    def advance(self, label: str | None = None) -> dict | None:
        """Manually advance to the next milestone."""
        if self.current_index < len(self.milestones) - 1:
            self.current_index += 1
            self.current_milestone = self.milestones[self.current_index]
            if self.current_milestone.emit and self.should_emit():
                return self.progress_event(
                    f"{self.label}: {self.current_milestone.label}"
                )
        return None

    def update(self, label: str) -> dict | None:
        """Update the current milestone label."""
        if self.should_emit():
            return self.progress_event(f"{self.label}: {label}")
        return None


async def stream_command(
    tool_id: str,
    command: str,
    cwd: str,
) -> AsyncIterator[dict]:
    """Stream a command with meaningful progress milestones.

    Detects common patterns (npm install, pytest, etc.) and emits
    appropriate progress updates.
    """
    tracker = MilestoneTracker(
        tool_id=tool_id,
        label=f"Run: {command[:50]}{'...' if len(command) > 50 else ''}",
        milestones=_command_milestones(command),
        icon="command",
    )

    yield tracker.initial_event()

    # Import the actual command runner
    from .tools import _run_command

    # Start the command in a task
    async def run_cmd():
        return await _run_command(command, cwd)

    cmd_task = asyncio.create_task(run_cmd())

    # Emit initial milestones
    async for evt in tracker.iter():
        if evt.get("type") == "activity" and not evt.get("done"):
            continue  # Skip intermediate milestone events
        yield evt

    # Wait for command to complete
    try:
        result = await cmd_task
        yield {
            "type": "tool_result",
            "tool": "run_command",
            "ok": result.get("ok", True),
            "message": result.get("output", ""),
        }
    except Exception as e:
        yield {
            "type": "tool_result",
            "tool": "run_command",
            "ok": False,
            "message": str(e),
        }


async def stream_batch_read(
    tool_id: str,
    paths: list[str],
) -> AsyncIterator[dict]:
    """Stream batch file reads with progress updates."""
    total = len(paths)
    label = f"Reading {total} file{'s' if total > 1 else ''}"

    tracker = MilestoneTracker(
        tool_id=tool_id,
        label=label,
        milestones=[
            Milestone("Starting...", 0.0),
            Milestone(f"Reading {total} files...", 0.5),
            Milestone("Processing...", 0.9),
        ],
        icon="file",
    )

    yield tracker.initial_event()

    results = []
    for i, path in enumerate(paths):
        if tracker.should_emit():
            yield tracker.progress_event(
                f"{label}: {i + 1}/{total}"
            )

        # Read the file
        from .tools import _read_file
        try:
            content = await asyncio.to_thread(_read_file, path)
            results.append({"path": path, "content": content, "ok": True})
        except Exception as e:
            results.append({"path": path, "error": str(e), "ok": False})

    yield {
        "type": "activity",
        "id": tool_id,
        "label": label,
        "icon": "file",
        "done": True,
    }

    # Format results
    formatted = []
    for r in results:
        if r.get("ok"):
            formatted.append(f"## {r['path']}\n{r['content'][:1000]}")
        else:
            formatted.append(f"## {r['path']}\nError: {r['error']}")

    yield {
        "type": "tool_result",
        "tool": "batch_read_files",
        "ok": True,
        "message": "\n\n".join(formatted),
    }


async def stream_search(
    tool_id: str,
    pattern: str,
    path: str,
) -> AsyncIterator[dict]:
    """Stream file search with progress updates."""
    import fnmatch
    from pathlib import Path as StdPath

    tracker = MilestoneTracker(
        tool_id=tool_id,
        label=f"Search: {pattern}",
        milestones=[
            Milestone("Scanning files...", 0.3),
            Milestone("Searching content...", 0.7),
            Milestone("Compiling results...", 0.9),
        ],
        icon="search",
    )

    yield tracker.initial_event()
    yield tracker.progress_event("Scanning files...")

    # Collect matching files
    matches = []
    search_root = StdPath(path).expanduser()
    file_count = 0

    for root, dirs, files in os.walk(search_root):
        file_count += len(files)
        if tracker.should_emit():
            yield tracker.progress_event(f"Scanning... {file_count} files")

        for filename in files:
            filepath = StdPath(root) / filename
            # Check filename match
            if fnmatch.fnmatch(filename, pattern):
                matches.append(str(filepath))

    # If pattern looks like regex, also search content
    if re.match(r"^/.*/$", pattern):
        yield tracker.progress_event("Searching content...")
        regex = re.compile(pattern.strip("/"))
        for root, dirs, files in os.walk(search_root):
            for filename in files:
                filepath = StdPath(root) / filename
                try:
                    content = filepath.read_text(encoding="utf-8", errors="ignore")
                    if regex.search(content):
                        matches.append(str(filepath))
                except Exception:
                    pass

    yield {
        "type": "activity",
        "id": tool_id,
        "label": f"Search: {pattern}",
        "icon": "search",
        "done": True,
    }

    yield {
        "type": "tool_result",
        "tool": "search_files",
        "ok": True,
        "message": "\n".join(matches) if matches else "No matches found",
    }


def _command_milestones(command: str) -> list[Milestone]:
    """Generate appropriate milestones for common command patterns."""
    cmd_lower = command.lower()

    # Package installation
    if "npm install" in cmd_lower or "npm ci" in cmd_lower:
        return [
            Milestone("Installing dependencies...", 0.3),
            Milestone("Fetching packages...", 0.6),
            Milestone("Building...", 0.9),
        ]

    # Testing
    if "pytest" in cmd_lower or "test" in cmd_lower:
        return [
            Milestone("Discovering tests...", 0.2),
            Milestone("Running tests...", 0.7),
            Milestone("Collecting results...", 0.9),
        ]

    # Building
    if "build" in cmd_lower:
        return [
            Milestone("Starting build...", 0.2),
            Milestone("Compiling...", 0.6),
            Milestone("Finalizing...", 0.9),
        ]

    # Git operations
    if cmd_lower.startswith("git "):
        return [
            Milestone("Running git command...", 0.5),
            Milestone("Finalizing...", 0.9),
        ]

    # Generic milestones
    return [
        Milestone("Starting...", 0.2),
        Milestone("Processing...", 0.7),
        Milestone("Finalizing...", 0.9),
    ]
