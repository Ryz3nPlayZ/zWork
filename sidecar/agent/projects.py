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


def create(name: str, description: str = "") -> Project:
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
    p = project_dir(project_id) / "project.json"
    if not p.exists():
        return None
    try:
        return Project(**json.loads(p.read_text(encoding="utf-8")))
    except Exception:
        return None


def list_all() -> list[dict]:
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
