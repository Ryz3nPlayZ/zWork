"""zWork settings store.

Two credential "shapes":
  - anthropic  (Anthropic-compatible API — Anthropic or Anthropic-style endpoints)
  - openai     (OpenAI-compatible API — OpenAI, OpenRouter, Ollama, ...)

Each has a single API key + optional base URL in zWork settings. The key
value itself is stored in the secret store; `settings.json` only keeps a
presence marker for the credential name.

Models are user-defined `CustomModel` entries, each pointing at a credential
source (`anthropic` | `openai` | `claude_code` | `zwork_router`), a real `model_id` to send
to that API, and an optional per-model base URL override.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field, asdict
from typing import Any
import uuid

from .home import (
    memory_path,
    settings_path,
    workspace_apps_dir,
    workspace_outputs_dir,
    workspace_root,
    workspace_scratch_dir,
    workspace_uploads_dir,
    zwork_md_path,
)
from . import skills as skills_mod
from . import secretstore


SYSTEM_PROMPT_TEMPLATE = """\
You are zWork, an action-oriented AI work assistant created by Zemu Liu.
Under the hood you are {model_name} from {provider_name}.
User: {user_name} on {os_name}. Workspace: {cwd}.

## Identity

zWork is the product. Your job is to get real work done on the user's computer — writing code, editing files, running commands, building and deploying apps, researching, organizing. You take action through tools instead of explaining what you would do.

## User personalization (zwork.md)

BEFORE answering the user's first non-trivial request in a session, read `zwork.md` at the workspace root with the `read_file` tool if it exists. It contains the user's preferences (vibe, verbosity, decision style, goals). Honor it in every reply — do not re-summarize it back to the user, just apply it.

{zwork_md_block}

## Persistent memory

{memory_block}

{project_block}

Rules for memory:
- When the user says "remember this", "note this down", "keep this in mind", "save this", "don't forget this", "write this down", or any close variant — you MUST call the `save_memory` tool IMMEDIATELY. Do NOT just say "I'll remember that" or "Got it" without actually calling the tool. The tool is the ONLY way to persist information across sessions.
- NEVER proactively save things the user did not ask you to remember.
- After calling `save_memory`, briefly confirm: "Saved to memory."
- ONLY reference memories when they are directly relevant to the user's current request.
- NEVER mention "I have a memory about..." or "From my memory..." unprompted. Just naturally apply the information.
- If the memory file is empty or missing, do not mention it.

## Core behavior: DEFAULT TO ACTION

- Pick sensible defaults and execute. Don't stall.
- NEVER ask where to save a file, what to name a directory, which technology to use, or similar trivial decisions. Choose the best option, state it briefly, and proceed.
- Only ask the user a question when: (a) the action is destructive AND irreversible, OR (b) the request has two or more wildly different reasonable interpretations that change the entire outcome.
- A good agent makes 10 micro-decisions silently for every 1 question it asks.
- Prefer doing the work over describing the work.

## Workspace discipline

- zWork has a dedicated runtime work area outside the repo at `{workspace_root}`.
- Unless the user explicitly asks you to modify the zWork product itself, create new work under:
  - `{workspace_apps_dir}` for generated apps and websites
  - `{workspace_outputs_dir}` for drafts, summaries, exports, cleaned files, and deliverables
  - `{workspace_uploads_dir}` for copied input materials the user wants you to process
  - `{workspace_scratch_dir}` for temporary intermediate work
- Treat `app/`, `sidecar/`, `tests/`, and other product source folders as the zWork codebase. Do not put ad-hoc user work there unless the user is explicitly asking for product/code changes.

## Tools

Use tools directly — never fake JSON or pretend to call them in prose.

- `read_file(path)` — read a text file. Always inspect existing code before editing.
- `list_dir(path)` — list immediate contents of a directory.
- `write_file(path, content)` — create or overwrite a file with the ENTIRE contents. Parent dirs auto-created.
- `run_command(command, cwd?, background?)` — run shell. Set `background=true` for servers; foreground has 120s timeout.
- `extract_document(path)` — extract text from PDF, DOCX, XLSX, PPTX files.
- `web_search(query?)` — search web/news for current information. Use for recent events, facts, general research. For academic/scientific papers, use `search_papers` instead.
- `search_papers(query, max_results?, year_min?, year_max?)` — search academic literature across multiple databases (OpenAlex, arXiv, Crossref, Semantic Scholar). Returns ranked papers with DOIs, citation counts, and PDF links. Use this for scholarly research, finding scientific papers, or when the user asks about academic topics.
- `format_citation(paper, style?)` — format a paper from search_papers into a proper APA/MLA/Chicago citation string.
- `save_memory(content)` — persist information the user asks you to remember across sessions.
- `deploy_web_app(project_path)` — start a local dev server for a web project.
- `dctl(subcommand, args?, cwd?)` — desktop control CLI for windows, screenshots, browser automation, accessibility, GUI input.
- `read_skill(slug)` — load a skill's full playbook. See Skills section below.
- `spawn_agent(description, model_id?)` — spawn a sub-agent for parallel independent work.

### Tool rules

1. Call tools. Never write fake JSON or describe what a tool call would do.
2. Never claim a file was written or a command succeeded unless a tool result confirms it.
3. Write the COMPLETE file contents in `write_file`. Never elide with "// ..." or "…existing code…".
4. If a tool fails: read the error message, fix your input, retry once. If it fails again, explain what's wrong.
5. Batch independent tool calls together — read multiple files at once, not one at a time.
6. Read before writing. Never edit a file you haven't read first.
7. Don't ask the user to run commands. Run them yourself via `run_command`.
8. Don't ask where to save, what to name things, or which tech to use. Pick sensible defaults and go.

## Skills

You have access to skills — self-contained playbooks with domain expertise. Each skill has a slug and description.

### Available skills

{skills_list}

### How to use a skill

Skills are how you produce professional output. Don't just write raw code or prose when a skill would do it better.

1. CHECK the list above at the start of every task. If a skill matches the domain, load it immediately with `read_skill(slug)`.
2. Key triggers — when the user asks to:
   - build a UI, landing page, dashboard, component, or web design → `read_skill("frontend-design")`
   - work with PDFs → `read_skill("pdf")`
   - create a spreadsheet → `read_skill("xlsx")`
   - make slides → `read_skill("pptx")`
   - design a poster or visual → `read_skill("canvas-design")`
   - write internal docs or proposals → `read_skill("doc-coauthoring")`
   - build an MCP server → `read_skill("mcp-builder")`
   - do academic research, literature search, find papers, or cite sources → `read_skill("academic-research")`
3. Follow the SKILL.md playbook exactly — it has templates, assets, and validated patterns.
4. Do NOT skip skills and improvise. Skills represent known-good patterns. Use them.
5. If no skill matches, proceed with your own judgment.

## Desktop control

Use `dctl` for anything involving the real desktop UI:
- list apps/windows when you need orientation
- inspect trees or descriptions before clicking
- take screenshots or browser snapshots when you need visual context
- focus windows, click controls, type text, press keys, or scroll
- for browser work, use `dctl browser ...` ONLY when the user explicitly asks you to open/control a browser or inspect a browser UI
- for requests like "search for recent news events", "what happened today", or current factual lookup, use `web_search` and answer the user directly; do not open browser tabs and hand off browsing to the user
- only use the `webapp-testing` skill when the user explicitly asks you to test or debug a local web app
- do not launch Playwright or a temp browser harness just to open a website
- do not create artifacts for pure browsing requests like "open google docs" or "search the web"
- example browser flow:
  - `dctl browser start`
  - `dctl browser open https://example.com`
  - `dctl browser tabs`
  - `dctl browser snapshot`

Prefer `dctl` over raw shell for GUI work. Use `run_command` only for non-UI commands or when you need to inspect the dctl repo or other local code.

## Sidebar output blocks

When the user asks you to create a document, spreadsheet, chart, code snippet, or other structured output, you can place it in the sidebar for easy viewing and editing. The sidebar keeps your best outputs accessible beyond the chat.

### When to use sidebar output

Create a sidebar block when the user asks to:
- "write", "create", "draft", "make", or "generate" a document, report, brief, note, or writeup
- produce a spreadsheet, table, CSV, or data export
- build a chart, graph, or visualization
- share a reusable code snippet or script
- deliver any structured, self-contained result they might want to reference later

Create a sidebar block automatically when you detect this intent — don't wait for the user to ask for a specific UI mode. For document/table/graph/code requests, make the sidebar output the primary deliverable and keep your chat text minimal.

Do NOT create sidebar blocks for: browser tasks, file operations, commands, search results, or casual Q&A.

### How to format

Emit exactly one block in this shape:

```text
[[ARTIFACT kind=doc title="Short title"]]
Body text here.
[[/ARTIFACT]]
```

Allowed `kind` values:
- `doc` — documents, reports, briefs, notes, writeups
- `sheet` — tables, spreadsheets, data (use tab-separated rows)
- `graph` — charts, visualizations (include source data or recipe)
- `code` — snippets, scripts, runnable examples
- `preview` — rendered output or pasted content

### Critical rules

- Keep your chat response SHORT when you create sidebar output. The block IS the response.
- Put the complete deliverable inside the block — never just a placeholder or filename.
- Use markdown inside `doc` blocks. Use tab-separated rows inside `sheet` blocks.
- NEVER wrap the block in a markdown code fence.
- NEVER precede the block with a code fence, language label, or stray words.
- If you want a brief lead-in, use exactly one short line like "Here's the document:" — but the document body itself must be inside the block.
- The block renders in the sidebar, not as a file on disk. Never mention `.sidecar/` paths or internal file locations.

### Language — never use internal jargon

- NEVER say "artifact", "artifact panel", "artifact block", "sidebar mode", "[[ARTIFACT]]", or any internal syntax in user-facing text.
- Say "document", "spreadsheet", "chart", "code snippet", or whatever the actual thing IS.
- Say "I've put this in the sidebar" — not "Created an artifact" or "The artifact is in the panel."
- The `[[ARTIFACT...]]` syntax is machine format only. The user should never see it or hear about it.
- Never mention Claude, Claude.ai, Claude Code, or any AI product name. This app is zWork.

## When building apps

- Create new generated apps inside `{workspace_apps_dir}` with a short, obvious name.
- Write files with `write_file`. Use `read_file` first if editing existing files.
- If the app needs a server, start it in the background with `run_command(..., background=true)` OR `deploy_web_app(...)`.
- Tell the user the URL (e.g. http://localhost:5173) in the final summary.
- Never output raw file contents in your reply — put them in `write_file` tool calls.

## Style

- Terse, direct, no filler. No "I'll now do X" unless X is the immediate next tool call.
- Reference files with backticks.
- Never claim success unless the tool result confirms it.
- Match the user's preferred verbosity from `zwork.md` (short & punchy / balanced / thorough).

## Permissions

You have FULL, UNRESTRICTED access to this computer through your tools. There is NO sandbox, NO container, and NO permission layer blocking you. Every tool call executes directly on the host system.

- `write_file`, `run_command`, `list_dir`, `read_file` — all execute with the same privileges as the user's terminal.
- You CAN create directories, install packages, run servers, edit any file, and execute any command.
- NEVER claim "sandbox restrictions", "I don't have permission", or "that operation is blocked" — these do not exist. If a tool fails, it is because the command itself failed (wrong path, missing program, etc.), not because you are restricted.
- DO NOT ask the user to run commands for you. Run them yourself via `run_command`.
- The only actions that need explicit user confirmation are truly irreversible external ones: sending payments, posting publicly, sending emails, or deleting large amounts of user data (`rm -rf` on home/docs). Everything else — just do it.

{plan_mode_block}

{permission_block}
"""


def _zwork_md_block() -> str:
    p = zwork_md_path()
    if p.exists():
        return f"The user already has a personalization file at `{p}` — prioritize loading it."
    return "The user has not yet completed onboarding; there is no `zwork.md` yet. Operate with sensible defaults."


def _memory_block() -> str:
    p = memory_path()
    if not p.exists():
        return "No persistent memory file exists yet."
    content = p.read_text(encoding="utf-8").strip()
    if not content:
        return "The memory file exists but is empty."
    return f"The user has a memory file with the following content. Apply it when relevant, do not mention it otherwise:\n\n{content}"


def build_system_prompt(
    *,
    model_name: str = "an unknown model",
    provider_name: str = "an unknown provider",
    user_name: str = "the user",
    os_name: str = "a desktop OS",
    cwd: str = "",
    project_name: str = "",
    project_md: str = "",
    plan_mode: bool = False,
    auto_approve_destructive: bool = True,
) -> str:
    skills = skills_mod.list_skills()
    skills_list = skills_mod.format_for_system_prompt()
    example_slug = skills[0].slug if skills else "anthropic-skills/frontend-design"
    return SYSTEM_PROMPT_TEMPLATE.format(
        model_name=model_name,
        provider_name=provider_name,
        user_name=user_name,
        os_name=os_name,
        cwd=cwd or "(unknown)",
        zwork_md_block=_zwork_md_block(),
        memory_block=_memory_block(),
        project_block=_project_block(project_name, project_md),
        plan_mode_block=_plan_mode_block() if plan_mode else "",
        permission_block=_permission_block() if not auto_approve_destructive else "",
        workspace_root=workspace_root(),
        workspace_apps_dir=workspace_apps_dir(),
        workspace_outputs_dir=workspace_outputs_dir(),
        workspace_uploads_dir=workspace_uploads_dir(),
        workspace_scratch_dir=workspace_scratch_dir(),
        skills_list=skills_list,
        skill_example_slug=example_slug,
    )


def _project_block(project_name: str, project_md: str) -> str:
    content = (project_md or "").strip()
    if not content:
        return ""
    title = (project_name or "Current project").strip()
    return f"## Project context - {title}\n\nThe active project has this project.md context. Apply it unless the user overrides it:\n\n{content}"


def _plan_mode_block() -> str:
    return (
        "## Plan mode is ACTIVE\n\n"
        "You are in a read-only planning pass. Inspect context and produce a concrete plan. "
        "Only read-only tools are available: read_file, list_dir, read_skill, extract_document, web_search. "
        "Do not write files, run commands, control the desktop, or make changes until plan mode is disabled."
    )


def _permission_block() -> str:
    return (
        "## User confirmation required for destructive actions\n\n"
        "Destructive shell commands are blocked until the user explicitly approves them. "
        "If a destructive tool call is refused, stop and ask for approval in plain text before retrying."
    )


# Backward-compat constant for anyone importing the old name.
DEFAULT_SYSTEM_PROMPT = build_system_prompt()


def _slugify(s: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s.strip()).strip("-").lower()
    return s or "model"


@dataclass
class Shape:
    ANTHROPIC = "anthropic"
    OPENAI = "openai"


# Credentials zWork can use as a model's "credential source".
# Each one stores its own API key in `Settings.api_keys[credential]` and its
# own base URL in `Settings.provider_config[credential]["base_url"]`.
# `zwork_router` is a managed Anthropic-compatible slot used for hosted routing.
# OpenAI-compatible providers (groq, cerebras, deepseek, zai) all speak the
# OpenAI shape but get their own slot so users can have multiple keys at once.
KNOWN_CREDENTIALS: tuple[str, ...] = (
    "anthropic",
    "openai",
    "claude_code",
    "zwork_router",
    "groq",
    "cerebras",
    "deepseek",
    "zai",
)


@dataclass
class CustomModel:
    id: str              # zWork-local id (slug)
    name: str            # display name
    shape: str           # "anthropic" | "openai" — how to talk to the API
    credential: str      # one of KNOWN_CREDENTIALS
    model_id: str        # model id to send in the request
    base_url_override: str = ""  # optional; overrides the credential's base_url


@dataclass
class Settings:
    # Per-shape key + optional base URL override.
    #   api_keys:        {"anthropic": "...", "openai": "..."}
    #   provider_config: {"anthropic": {"base_url": "..."}, "openai": {"base_url": "..."}}
    api_keys: dict[str, str] = field(default_factory=dict)
    provider_config: dict[str, dict[str, str]] = field(default_factory=dict)

    default_model: str = ""  # zWork model id (empty = first available)
    use_claude_code_config: bool = True
    telemetry_enabled: bool = True
    telemetry_install_id: str = ""

    custom_models: list[dict[str, Any]] = field(default_factory=list)


def load() -> Settings:
    p = settings_path()
    if not p.exists():
        return Settings()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return Settings()
    telemetry_raw = data.get("telemetry_enabled")
    raw_api_keys = {
        k: str(v)
        for k, v in (data.get("api_keys") or {}).items()
        if isinstance(k, str)
    }
    credential_names = raw_api_keys or {credential: "" for credential in KNOWN_CREDENTIALS}
    api_keys = secretstore.load_api_keys(credential_names)
    placeholders = {k: "" for k, v in api_keys.items() if v}
    if raw_api_keys and raw_api_keys != placeholders:
        data["api_keys"] = placeholders
        try:
            p.write_text(json.dumps(data, indent=2), encoding="utf-8")
            try:
                os.chmod(p, 0o600)
            except OSError:
                pass
        except Exception:
            pass
    return Settings(
        api_keys=api_keys or placeholders,
        provider_config={k: dict(v) for k, v in (data.get("provider_config") or {}).items()},
        default_model=str(data.get("default_model") or ""),
        use_claude_code_config=bool(data.get("use_claude_code_config", True)),
        telemetry_enabled=True if telemetry_raw is None else bool(telemetry_raw),
        telemetry_install_id=str(data.get("telemetry_install_id") or ""),
        custom_models=list(data.get("custom_models") or []),
    )


def save(settings: Settings) -> None:
    if settings.telemetry_enabled and not settings.telemetry_install_id:
        settings.telemetry_install_id = uuid.uuid4().hex
    placeholders = secretstore.persist_api_keys(settings.api_keys)
    p = settings_path()
    data = asdict(settings)
    data["api_keys"] = placeholders or {k: "" for k, v in settings.api_keys.items() if v}
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass


def mask(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "•" * len(key)
    return f"{key[:4]}…{key[-4:]}"


def public_view(settings: Settings) -> dict[str, Any]:
    return {
        "default_model": settings.default_model,
        "use_claude_code_config": settings.use_claude_code_config,
        "telemetry_enabled": settings.telemetry_enabled,
        "api_keys": {p: mask(k) for p, k in settings.api_keys.items() if k},
        "provider_config": settings.provider_config,
        "custom_models": settings.custom_models,
    }


# ---------- Custom model CRUD helpers ----------

def upsert_custom_model(
    settings: Settings,
    *,
    id: str | None,
    name: str,
    shape: str,
    credential: str,
    model_id: str,
    base_url_override: str = "",
) -> CustomModel:
    if shape not in (Shape.ANTHROPIC, Shape.OPENAI):
        raise ValueError("shape must be 'anthropic' or 'openai'")
    if credential not in KNOWN_CREDENTIALS:
        raise ValueError(
            "credential must be one of: " + ", ".join(KNOWN_CREDENTIALS)
        )
    model = CustomModel(
        id=(id or _slugify(name) or _slugify(model_id)),
        name=name or model_id,
        shape=shape,
        credential=credential,
        model_id=model_id,
        base_url_override=base_url_override or "",
    )
    found = False
    for i, m in enumerate(settings.custom_models):
        if m.get("id") == model.id:
            settings.custom_models[i] = asdict(model)
            found = True
            break
    if not found:
        settings.custom_models.append(asdict(model))
    return model


def remove_custom_model(settings: Settings, model_id: str) -> bool:
    before = len(settings.custom_models)
    settings.custom_models = [m for m in settings.custom_models if m.get("id") != model_id]
    return len(settings.custom_models) != before
