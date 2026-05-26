"""zWork project management.

A project is a container for context (project.md) and associated conversations.
Projects live in ~/.zwork/projects/<id>/ with a project.json metadata file
and an optional project.md context file.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, asdict

from .home import project_dir, projects_dir
from .utils import uid


@dataclass
class Project:
    id: str
    name: str
    description: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0
    chat_ids: list[str] = field(default_factory=list)
    starred: bool = False
    icon: str = ""


def create(name: str, description: str = "") -> Project:
    """Create and persist a new chat record, returning its ID."""
    p = Project(
        id=uid(),
        name=name,
        description=description,
        created_at=time.time(),
        updated_at=time.time(),
    )
    d = project_dir(p.id)
    (d / "project.json").write_text(json.dumps(asdict(p), indent=2), encoding="utf-8")
    # Create empty project.md
    (d / "project.md").write_text(f"# {name}\n\n", encoding="utf-8")
    return p


def get(project_id: str) -> Project | None:
    """Load and return the chat record for *chat_id*, or None if not found."""
    p = project_dir(project_id) / "project.json"
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        import dataclasses
        valid_keys = {f.name for f in dataclasses.fields(Project)}
        filtered = {k: v for k, v in data.items() if k in valid_keys}
        return Project(**filtered)
    except Exception:
        return None


def list_all() -> list[dict]:
    """Return all stored chat records ordered by creation time descending."""
    results: list[dict] = []
    base = projects_dir()
    for child in sorted(base.iterdir()):
        if not child.is_dir():
            continue
        meta = child / "project.json"
        if not meta.exists():
            continue
        try:
            results.append(json.loads(meta.read_text(encoding="utf-8")))
        except Exception:
            continue
    return results


def update(project_id: str, **kwargs) -> Project | None:
    """Merge *fields* into the stored chat record for *chat_id* and persist."""
    p = get(project_id)
    if not p:
        return None
    for k, v in kwargs.items():
        if hasattr(p, k):
            setattr(p, k, v)
    p.updated_at = time.time()
    (project_dir(project_id) / "project.json").write_text(
        json.dumps(asdict(p), indent=2), encoding="utf-8"
    )
    return p


def delete(project_id: str) -> bool:
    """Remove the JSONL file for *chat_id* if it exists."""
    d = project_dir(project_id)
    if not (d / "project.json").exists():
        return False
    import shutil

    shutil.rmtree(d, ignore_errors=True)
    return True


def get_context(project_id: str) -> str | None:
    """Read the project.md context file."""
    md = project_dir(project_id) / "project.md"
    if not md.exists():
        return None
    return md.read_text(encoding="utf-8")


def set_context(project_id: str, content: str) -> bool:
    """Write the project.md context file."""
    p = get(project_id)
    if not p:
        return False
    (project_dir(project_id) / "project.md").write_text(content, encoding="utf-8")
    return True


def get_memory(project_id: str) -> str | None:
    """Read the project_memory.md file."""
    md = project_dir(project_id) / "project_memory.md"
    if not md.exists():
        return None
    return md.read_text(encoding="utf-8")


def set_memory(project_id: str, content: str) -> bool:
    """Write the project_memory.md file."""
    p = get(project_id)
    if not p:
        return False
    (project_dir(project_id) / "project_memory.md").write_text(content, encoding="utf-8")
    return True


def get_timeline(project_id: str) -> str | None:
    """Read the timeline.md file."""
    md = project_dir(project_id) / "timeline.md"
    if not md.exists():
        return None
    return md.read_text(encoding="utf-8")


def append_timeline(project_id: str, line: str) -> bool:
    """Append a line to the timeline.md file."""
    p = get(project_id)
    if not p:
        return False
    md = project_dir(project_id) / "timeline.md"
    existing = md.read_text(encoding="utf-8") if md.exists() else ""
    timestamp = time.strftime("%Y-%m-%d %H:%M")
    entry = f"- [{timestamp}] {line}\n"
    md.write_text(existing + entry, encoding="utf-8")
    return True
