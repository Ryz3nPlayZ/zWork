"""Tool execution for the chat agent.

Each tool is:
  - declared in TOOL_SCHEMAS for the LLM
  - implemented here with a clear contract:
      yields `activity` events (for the UI)
      yields exactly one `tool_result` event at the end
"""
from __future__ import annotations

import json
import os
import re
import sys
import subprocess
import shlex
from pathlib import Path
from typing import Any, AsyncIterator


# ---------------- Tool schemas (provider-neutral) ----------------

from . import skills as skills_mod
from .home import memory_path


TOOL_SCHEMAS: list[dict] = [
    {
        "name": "write_file",
        "description": (
            "Write content to a file at the given path. Creates parent directories if needed. "
            "Overwrites existing files. Use this for creating app files, code, docs, configs."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative or absolute file path"},
                "content": {"type": "string", "description": "Full UTF-8 content of the file"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "read_file",
        "description": (
            "Read and return the UTF-8 contents of a file. Use this to inspect files you or "
            "the user just wrote/changed, or to see existing project files before editing."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative or absolute file path"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_dir",
        "description": "List the immediate children of a directory. Use this to orient yourself.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path (default: '.')"},
            },
            "required": [],
        },
    },
    {
        "name": "run_command",
        "description": (
            "Run a shell command. Set background=true for long-running servers (e.g. dev servers); "
            "the command will detach and return immediately. For foreground commands, the combined "
            "stdout+stderr is returned (120s timeout)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute"},
                "cwd": {"type": "string", "description": "Working directory (default: '.')"},
                "background": {"type": "boolean", "description": "Run detached (for servers)"},
            },
            "required": ["command"],
        },
    },
    {
        "name": "read_skill",
        "description": (
            "Load the full SKILL.md for an installed skill so you can follow its playbook. "
            "Pass the skill slug (e.g. 'anthropic-skills/pdf' or 'uiux-pro-max'). "
            "The system prompt lists available skills. Call this when a user task matches a skill's domain."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "slug": {"type": "string", "description": "Skill slug or leaf folder name"},
            },
            "required": ["slug"],
        },
    },
    {
        "name": "deploy_web_app",
        "description": (
            "Serve a local web app directory on http://localhost:<port>. Picks a free port "
            "(prefers 5173, 8000, 3000). Uses `python3 -m http.server` for static sites, or "
            "`npm run dev` when package.json has a dev script. Returns the URL."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "project_path": {"type": "string", "description": "Path to the project root"},
                "framework": {"type": "string", "description": "Framework hint (optional)"},
            },
            "required": ["project_path"],
        },
    },
    {
        "name": "save_memory",
        "description": (
            "Append a fact or note to persistent memory. "
            "MUST be called whenever the user asks to remember, note down, or save something. "
            "Do NOT just acknowledge the request — actually invoke this tool."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "The fact or note to remember"},
            },
            "required": ["content"],
        },
    },
    {
        "name": "dctl",
        "description": (
            "Run the local dctl desktop-control CLI for window/app/browser automation, "
            "accessibility tree inspection, screenshots, and focus/click/type/scroll actions. "
            "Prefer this over raw shell for GUI work."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "subcommand": {"type": "string", "description": "dctl subcommand to run"},
                "args": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Arguments passed to the dctl subcommand",
                },
                "cwd": {"type": "string", "description": "Working directory for the command"},
            },
            "required": ["subcommand"],
        },
    },
]


# ---------------- Dispatcher ----------------

def _friendly_error(err: Exception, context: str = "") -> str:
    """Translate common exceptions into user-actionable messages."""
    msg = str(err)

    if isinstance(err, FileNotFoundError):
        return f"File not found: {msg}. Check the path and try again."
    if isinstance(err, NotADirectoryError):
        return f"Not a directory: {msg}. Specify a directory path instead."
    if isinstance(err, IsADirectoryError):
        return f"Is a directory, not a file: {msg}. Specify a file path instead."
    if isinstance(err, PermissionError):
        return f"Permission denied: {msg}. Check file permissions and try again."
    if isinstance(err, UnicodeDecodeError):
        return f"Cannot read as text: {msg}. The file may be binary or use an unsupported encoding."
    if isinstance(err, subprocess.TimeoutExpired):
        return f"Command timed out after {err.timeout}s. Try breaking the work into smaller steps."
    if isinstance(err, OSError):
        return f"System error: {msg}. {context}Check that the path and permissions are correct."

    return f"{msg}. {context}" if context else msg


async def execute_tool(tool_name: str, params: dict[str, Any]) -> AsyncIterator[dict]:
    tool_id = f"tool_{tool_name}_{id(params)}"

    # MCP-prefixed tools (e.g. `mcp__linear__create_issue`) route through the
    # MCP manager — registered at startup based on `~/.zwork/mcp.json`.
    if tool_name.startswith("mcp__"):
        from .mcp import get_manager
        label = f"MCP: {tool_name}"
        yield {"type": "activity", "id": tool_id, "label": label, "icon": "tool", "done": False}
        try:
            result = await get_manager().call_tool(tool_name, params)
            ok = not result.get("isError", False)
            content = result.get("content") or []
            text_chunks = [c.get("text", "") for c in content if c.get("type") == "text"]
            message = "\n".join(t for t in text_chunks if t) or json.dumps(result)
            yield {"type": "activity", "id": tool_id, "label": label, "icon": "tool", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": ok, "message": message}
        except Exception as e:  # noqa: BLE001
            yield {"type": "activity", "id": tool_id, "label": f"Failed: {label}", "icon": "tool", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": False, "message": _friendly_error(e, "")}
        return

    if tool_name == "write_file":
        path = params.get("path", "")
        content = params.get("content", "")
        label = f"Write {_short_path(path)}"
        icon = _icon_for_path(path)
        yield {"type": "activity", "id": tool_id, "label": label, "icon": icon, "done": False}
        try:
            _write_file(path, content)
            yield {"type": "activity", "id": tool_id, "label": label, "icon": icon, "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": True,
                   "message": f"Wrote {len(content)} chars to {path}"}
        except Exception as e:
            yield {"type": "activity", "id": tool_id, "label": f"Failed: {label}", "icon": icon, "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": False, "message": _friendly_error(e, "Try a different path. ")}
        return

    if tool_name == "read_file":
        path = params.get("path", "")
        label = f"Read {_short_path(path)}"
        icon = _icon_for_path(path)
        yield {"type": "activity", "id": tool_id, "label": label, "icon": icon, "done": False}
        try:
            text = _read_file(path)
            yield {"type": "activity", "id": tool_id, "label": label, "icon": icon, "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": True, "message": text}
        except Exception as e:
            yield {"type": "activity", "id": tool_id, "label": f"Failed: {label}", "icon": icon, "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": False, "message": _friendly_error(e, "Try a different path. ")}
        return

    if tool_name == "list_dir":
        path = params.get("path", ".")
        label = f"List {_short_path(path)}"
        yield {"type": "activity", "id": tool_id, "label": label, "icon": "folder", "done": False}
        try:
            listing = _list_dir(path)
            yield {"type": "activity", "id": tool_id, "label": label, "icon": "folder", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": True, "message": listing}
        except Exception as e:
            yield {"type": "activity", "id": tool_id, "label": f"Failed: {label}", "icon": "folder", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": False, "message": _friendly_error(e, "Check that the path is a directory. ")}
        return

    if tool_name == "run_command":
        command = params.get("command", "")
        cwd = params.get("cwd", ".")
        background = bool(params.get("background", False))
        short = command[:60] + ("…" if len(command) > 60 else "")
        label = f"Run: {short}" + (" (bg)" if background else "")
        yield {"type": "activity", "id": tool_id, "label": label, "icon": "command", "done": False}
        try:
            if background:
                pid = _run_background(command, cwd)
                yield {"type": "activity", "id": tool_id, "label": label, "icon": "command", "done": True}
                yield {"type": "tool_result", "tool": tool_name, "ok": True,
                       "message": f"Started background process (pid={pid})"}
            else:
                result = _run_command(command, cwd)
                yield {"type": "activity", "id": tool_id, "label": label, "icon": "command", "done": True}
                yield {"type": "tool_result", "tool": tool_name, "ok": result["ok"],
                       "message": result["output"] or (f"exit {result['returncode']}")}
        except Exception as e:
            yield {"type": "activity", "id": tool_id, "label": f"Failed: {label}", "icon": "command", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": False, "message": _friendly_error(e)}
        return

    if tool_name == "read_skill":
        slug = params.get("slug", "")
        label = f"Read skill {slug}"
        yield {"type": "activity", "id": tool_id, "label": label, "icon": "file", "done": False}
        try:
            text = skills_mod.read_skill(slug)
            if text is None:
                available = ", ".join(s.slug for s in skills_mod.list_skills()[:10])
                msg = f"No skill named '{slug}'. Try one of: {available}"
                yield {"type": "activity", "id": tool_id, "label": f"Failed: {label}", "icon": "file", "done": True}
                yield {"type": "tool_result", "tool": tool_name, "ok": False, "message": msg}
            else:
                # Cap to keep context sane.
                if len(text) > 80_000:
                    text = text[:80_000] + "\n…[truncated]"
                yield {"type": "activity", "id": tool_id, "label": label, "icon": "file", "done": True}
                yield {"type": "tool_result", "tool": tool_name, "ok": True, "message": text}
        except Exception as e:
            yield {"type": "activity", "id": tool_id, "label": f"Failed: {label}", "icon": "file", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": False, "message": _friendly_error(e, "Check the skill slug spelling. ")}
        return

    if tool_name == "deploy_web_app":
        project_path = params.get("project_path", ".")
        framework = params.get("framework", "")
        label = f"Serve {_short_path(project_path)}"
        yield {"type": "activity", "id": tool_id, "label": label, "icon": "deploy", "done": False}
        try:
            result = _deploy_web_app(project_path, framework)
            yield {"type": "activity", "id": tool_id, "label": label, "icon": "deploy", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": result["ok"],
                   "message": result["message"]}
        except Exception as e:
            yield {"type": "activity", "id": tool_id, "label": f"Failed: {label}", "icon": "deploy", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": False, "message": _friendly_error(e)}
        return

    if tool_name == "save_memory":
        content = params.get("content", "")
        label = "Save memory"
        yield {"type": "activity", "id": tool_id, "label": label, "icon": "file", "done": False}
        try:
            _save_memory(content)
            yield {"type": "activity", "id": tool_id, "label": label, "icon": "file", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": True,
                   "message": "Saved to memory."}
        except Exception as e:
            yield {"type": "activity", "id": tool_id, "label": f"Failed: {label}", "icon": "file", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": False, "message": _friendly_error(e)}
        return

    if tool_name == "dctl":
        subcommand = str(params.get("subcommand", "")).strip()
        args = [str(a) for a in (params.get("args") or []) if str(a).strip()]
        cwd = params.get("cwd", ".")
        full = " ".join([subcommand, *args]).strip()
        label = f"dctl {full}" if full else "dctl"
        yield {"type": "activity", "id": tool_id, "label": label, "icon": "window", "done": False}
        try:
            result = _run_dctl(subcommand, args, cwd)
            yield {"type": "activity", "id": tool_id, "label": label, "icon": "window", "done": True}
            yield {
                "type": "tool_result",
                "tool": tool_name,
                "ok": result["ok"],
                "message": result["output"] or (f"exit {result['returncode']}" if not result["ok"] else "ok"),
            }
        except Exception as e:
            yield {"type": "activity", "id": tool_id, "label": f"Failed: {label}", "icon": "window", "done": True}
            yield {"type": "tool_result", "tool": tool_name, "ok": False, "message": _friendly_error(e, "Check that dctl is installed and the subcommand is valid. ")}
        return

    yield {"type": "tool_result", "tool": tool_name, "ok": False,
           "message": f"Unknown tool: {tool_name}. This tool is not available — try a different approach."}


# ---------------- Impls ----------------

def _short_path(path: str) -> str:
    try:
        home = str(Path.home())
        s = str(path)
        if s.startswith(home):
            s = "~" + s[len(home):]
        return s
    except Exception:
        return str(path)


def _icon_for_path(path: str) -> str:
    ext = Path(path).suffix.lower()
    if ext in (".html", ".htm"):
        return "html"
    if ext in (".css",):
        return "css"
    if ext in (".js", ".mjs"):
        return "js"
    if ext in (".ts", ".tsx"):
        return "ts"
    if ext in (".jsx",):
        return "jsx"
    if ext in (".json",):
        return "json"
    if ext in (".py",):
        return "code"
    if ext in (".md", ".markdown"):
        return "file"
    return "file"


def _write_file(path: str, content: str) -> None:
    p = Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def _read_file(path: str) -> str:
    p = Path(path).expanduser()
    data = p.read_text(encoding="utf-8", errors="replace")
    # Cap to avoid flooding the context
    if len(data) > 200_000:
        return data[:200_000] + "\n…[truncated]"
    return data


def _list_dir(path: str) -> str:
    p = Path(path).expanduser()
    if not p.exists():
        raise FileNotFoundError(f"No such directory: {path}")
    if not p.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    entries = []
    for child in sorted(p.iterdir()):
        suffix = "/" if child.is_dir() else ""
        entries.append(child.name + suffix)
    return "\n".join(entries) if entries else "(empty)"


def _run_command(command: str, cwd: str) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=Path(cwd).expanduser(),
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "returncode": -1,
            "output": f"Command timed out after 120s. Try a shorter command or break the work into smaller steps.",
        }
    output = result.stdout
    if result.stderr:
        output += ("\n" + result.stderr) if output else result.stderr
    # Cap output
    if len(output) > 20_000:
        output = output[:20_000] + "\n…[truncated]"
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "output": output.strip(),
    }


def _run_background(command: str, cwd: str) -> int:
    """Start a detached background process. Returns PID."""
    proc = subprocess.Popen(
        command,
        shell=True,
        cwd=Path(cwd).expanduser(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    return proc.pid


def _pick_free_port(preferred: list[int]) -> int:
    import socket
    for port in preferred:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    # fall back to kernel-assigned
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _deploy_web_app(project_path: str, framework: str) -> dict[str, Any]:
    """Actually start a server."""
    p = Path(project_path).expanduser().resolve()
    if not p.exists():
        return {"ok": False, "message": f"Project path does not exist: {project_path}"}
    if not p.is_dir():
        return {"ok": False, "message": f"Project path is not a directory: {project_path}"}

    pkg = p / "package.json"
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text())
            scripts = data.get("scripts") or {}
            if "dev" in scripts:
                port = _pick_free_port([5173, 3000, 8080])
                # Pass PORT env for CRA/Next; Vite uses --port via the script itself if configured.
                command = f"PORT={port} npm run dev"
                _run_background(command, str(p))
                return {"ok": True,
                        "message": f"Started `npm run dev` in {p.name}. Open http://localhost:{port} "
                                   f"(check console if your dev server chose a different port)."}
            if "start" in scripts:
                port = _pick_free_port([3000, 8080])
                _run_background(f"PORT={port} npm start", str(p))
                return {"ok": True,
                        "message": f"Started `npm start` in {p.name}. Open http://localhost:{port}."}
        except Exception:
            pass

    index = p / "index.html"
    if index.exists():
        port = _pick_free_port([8000, 8080, 5173])
        _run_background(f"python3 -m http.server {port}", str(p))
        return {"ok": True,
                "message": f"Serving {p.name} at http://localhost:{port}"}

    return {"ok": False,
            "message": f"No index.html or package.json in {p}. Nothing obvious to serve."}


def _save_memory(content: str) -> None:
    """Append a note to the global memory file."""
    import time as _time
    p = memory_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    existing = ""
    if p.exists():
        existing = p.read_text(encoding="utf-8").rstrip()
    timestamp = _time.strftime("%Y-%m-%d")
    entry = f"\n- {content}  ({timestamp})"
    p.write_text((existing + entry + "\n"), encoding="utf-8")


def _dctl_env() -> dict[str, str]:
    env = os.environ.copy()
    repo = Path(__file__).resolve().parents[3] / "dctl"
    if repo.exists():
        prev = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = f"{repo}{os.pathsep}{prev}" if prev else str(repo)
    return env


def _run_dctl(subcommand: str, args: list[str], cwd: str) -> dict[str, Any]:
    if not subcommand:
        raise ValueError("dctl requires a subcommand")
    cmd = [sys.executable, "-m", "dctl", subcommand, *args]
    try:
        result = subprocess.run(
            cmd,
            cwd=Path(cwd).expanduser(),
            capture_output=True,
            text=True,
            timeout=120,
            env=_dctl_env(),
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "returncode": -1,
            "output": "dctl command timed out after 120s. Try a simpler operation.",
        }
    output = result.stdout
    if result.stderr:
        output += ("\n" + result.stderr) if output else result.stderr
    if len(output) > 20_000:
        output = output[:20_000] + "\n…[truncated]"
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "output": output.strip(),
    }


# ---------------- Legacy <<TOOL>> marker parser ----------------

def parse_tool_calls(text: str) -> list[dict[str, Any]]:
    """Parse <<TOOL>>...<</TOOL>> blocks from model output (fallback)."""
    calls: list[dict[str, Any]] = []
    pattern = r"<<TOOL>>([\s\S]*?)<</TOOL>>"
    for match in re.finditer(pattern, text):
        try:
            data = json.loads(match.group(1).strip())
            if isinstance(data, dict) and "tool" in data and "params" in data:
                calls.append(data)
        except (json.JSONDecodeError, KeyError):
            continue
    return calls


# silence linters on unused import
_ = shlex
_ = os
