"""zWork backend: FastAPI server."""
from __future__ import annotations

import json
import os
import platform
import getpass
import re
import base64
import binascii
import mimetypes
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    from .agent import chatstore, detect, providers, skills as skills_mod
    from .agent import settings as settings_mod
    from .agent import home as home_mod
    from .agent import projects as projects_mod
    from .agent.env_loader import load_dotenv
    from .core.util import new_id
except ImportError:  # pragma: no cover - PyInstaller/script entrypoint fallback
    from sidecar.agent import chatstore, detect, providers, skills as skills_mod
    from sidecar.agent import settings as settings_mod
    from sidecar.agent import home as home_mod
    from sidecar.agent import projects as projects_mod
    from sidecar.agent.env_loader import load_dotenv
    from sidecar.core.util import new_id

# Load .env from repo root (optional).
load_dotenv()

app = FastAPI(title="zWork", version="0.1.0")

# Serve built frontend as static files when running as a web app.
_STATIC_DIR = Path(__file__).resolve().parent.parent / "app" / "dist"
if _STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=_STATIC_DIR / "assets"), name="assets")

app.add_middleware(
    CORSMiddleware,
    # Backend is bound to 127.0.0.1 only, so wildcarding origins is safe.
    # The Tauri bundled app loads from a `tauri://` or `http://tauri.localhost`
    # origin depending on platform, and the dev server from :1420.
    allow_origin_regex=".*",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------- Schemas ----------------

class SettingsPatch(BaseModel):
    api_keys: dict[str, str] | None = None
    provider_config: dict[str, dict[str, str]] | None = None
    default_model: str | None = None
    use_claude_code_config: bool | None = None


class CustomModelBody(BaseModel):
    id: str | None = None
    name: str
    shape: str            # "anthropic" | "openai"
    credential: str       # "anthropic" | "openai" | "claude_code"
    model_id: str
    base_url_override: str = ""


class ChatCreate(BaseModel):
    title: str = "New chat"
    model: str = ""


class ChatRename(BaseModel):
    title: str


class StreamRequest(BaseModel):
    chat_id: str | None = None
    message: str
    model: str | None = None
    new_chat_title: str | None = None
    artifact_mode: bool = True
    attachments: list[UploadItem] | None = None


class ProjectCreate(BaseModel):
    name: str
    description: str = ""


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class ContentBody(BaseModel):
    content: str


class UploadItem(BaseModel):
    client_id: str | None = None
    name: str
    mime: str = "application/octet-stream"
    kind: str = "file"
    path: str | None = None
    text_content: str | None = None
    data_url: str | None = None


class UploadBody(BaseModel):
    files: list[UploadItem]


def _artifact_hint(message: str) -> str:
    t = message.lower()
    if any(k in t for k in ["document", "doc", "brief", "report", "note", "summary", "outline", "write a", "draft a", "make a document"]):
        return "The user's request clearly wants a document artifact. Create a sidebar artifact of kind doc."
    if any(k in t for k in ["table", "sheet", "spreadsheet", "csv", "tsv", "rows", "columns"]):
        return "The user's request clearly wants a table or spreadsheet artifact. Create a sidebar artifact of kind sheet."
    if any(k in t for k in ["chart", "graph", "plot", "visualization", "visualise", "visualize"]):
        return "The user's request clearly wants a graph artifact. Create a sidebar artifact of kind graph."
    if any(k in t for k in ["code snippet", "script", "example code", "runnable example"]):
        return "The user's request clearly wants a code artifact. Create a sidebar artifact of kind code."
    return "The user's request may or may not want an artifact. If the output is best represented as an editable deliverable, create one."


# ---------------- Health / meta ----------------

@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


def _os_pretty() -> str:
    sys = platform.system()
    if sys == "Darwin":
        return f"macOS {platform.mac_ver()[0]}".strip()
    if sys == "Windows":
        return f"Windows {platform.release()}"
    return f"{sys} {platform.release()}"


def _display_name() -> str:
    preferred = _preferred_name()
    if preferred:
        return preferred

    # Prefer macOS full name if available.
    try:
        if platform.system() == "Darwin":
            import subprocess as _sp
            out = _sp.run(["id", "-F"], capture_output=True, text=True, timeout=2)
            full = (out.stdout or "").strip()
            if full:
                return full.split()[0]
    except Exception:
        pass
    try:
        return (os.environ.get("USER") or getpass.getuser() or "").strip() or "friend"
    except Exception:
        return "friend"


def _normalize_name(value: str) -> str:
    cleaned = " ".join((value or "").strip().split())
    if not cleaned:
        return ""
    return cleaned.split()[0]


def _preferred_name_from_answers(answers: list[OnboardAnswer]) -> str:
    for a in answers:
        if a.key == "name" and a.answer.strip():
            return _normalize_name(a.answer)
    for a in answers:
        if "call you" in a.question.lower() and a.answer.strip():
            return _normalize_name(a.answer)
    return ""


def _preferred_name_from_zwork_md() -> str:
    p = home_mod.zwork_md_path()
    if not p.exists():
        return ""
    try:
        text = p.read_text(encoding="utf-8")
    except Exception:
        return ""

    patterns = [
        r"What should I call you\?\s*\n\s*→\s*([^\n]+)",
        r"-\s*Name:\s*([^\n]+)",
        r"User name:\s*([^\n]+)",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, flags=re.IGNORECASE)
        if m:
            candidate = _normalize_name(m.group(1))
            if candidate:
                return candidate
    return ""


def _preferred_name_from_state_answers(raw_answers: Any) -> str:
    if not isinstance(raw_answers, list):
        return ""
    for item in raw_answers:
        if not isinstance(item, dict):
            continue
        answer = _normalize_name(str(item.get("answer") or ""))
        if not answer:
            continue
        key = str(item.get("key") or "").strip().lower()
        question = str(item.get("question") or "").lower()
        if key == "name" or "call you" in question:
            return answer
    return ""


def _preferred_name() -> str:
    st = _onboarding_state()
    candidate = _preferred_name_from_state_answers(st.get("answers"))
    if candidate:
        return candidate
    candidate = _preferred_name_from_zwork_md()
    if candidate:
        return candidate
    return _normalize_name(str(st.get("display_name") or st.get("name") or ""))


@app.get("/api/me")
def me() -> dict:
    name = _display_name()
    return {
        "name": name,
        "os": _os_pretty(),
        "cwd": str(Path.cwd()),
    }


# ---------------- Skills ----------------

@app.get("/api/skills")
def skills_list(refresh: bool = False) -> dict:
    if refresh:
        skills_mod.list_skills(refresh=True)
    return {"skills": skills_mod.as_dicts()}


# ---------------- Onboarding ----------------

class OnboardAnswer(BaseModel):
    key: str
    question: str
    answer: str


class OnboardBody(BaseModel):
    """Full onboarding payload. `answers` is the Q/A list; `credential` is the
    chosen provider setup (shape/base_url/api_key/model_id)."""
    answers: list[OnboardAnswer]
    credential: dict[str, str] | None = None  # {shape, credential, api_key, base_url, model_id, model_name}
    prefer_theme: str | None = None  # "light" | "dark" | "system"


def _onboarding_state() -> dict:
    p = home_mod.onboarding_path()
    if not p.exists():
        return {"completed": False}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {"completed": False}


@app.get("/api/onboard/status")
def onboard_status() -> dict:
    s = _onboarding_state()
    s["zwork_md_exists"] = home_mod.zwork_md_path().exists()
    return s


@app.post("/api/onboard/skip")
def onboard_skip() -> dict:
    home_mod.onboarding_path().write_text(
        json.dumps({"completed": True, "skipped": True})
    )
    return {"ok": True}


async def _generate_zwork_md(answers: list[OnboardAnswer], user_name: str) -> str:
    """Call the configured LLM to generate zwork.md. Falls back to a templated
    version if no model is available."""
    s = settings_mod.load()
    avail = providers.available_models(s)
    model_id = s.default_model if s.default_model else (avail[0]["id"] if avail else "")

    qna_lines = [
        f"- {a.question}\n  → {a.answer}"
        for a in answers
        if a.answer and a.answer.strip()
    ]
    qna_text = "\n".join(qna_lines)

    if not model_id:
        # Fallback: template the answers directly.
        return _fallback_zwork_md(user_name, qna_text, answers)

    system = (
        "Your ONLY job is to emit the raw text contents of a markdown file. "
        "Do not explain anything. Do not ask questions. Do not use tools. "
        "Do not wrap in code fences. Do not add a preamble or signoff. "
        "Output text starts with '# zWork personalization' and nothing before it."
    )
    user = (
        "Generate a zwork.md personalization file for an AI work assistant, based "
        "on the onboarding answers below.\n\n"
        "Required structure (keep under 400 words total):\n"
        "# zWork personalization\n\n"
        "## About the user\n"
        "(3–4 bullets summarizing who they are)\n\n"
        "## Preferences\n"
        "(vibe, verbosity, decision style — bullets with **bold** keys)\n\n"
        "## How to talk to me\n"
        "(4–6 concrete rules the assistant must follow, imperative voice, "
        "derived directly from the user's answers)\n\n"
        f"User name: {user_name}\n\n"
        f"Onboarding answers:\n{qna_text}\n\n"
        "Emit the file content now. First line MUST be exactly `# zWork personalization`."
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

    # Stream the chat and collect the text
    text_parts: list[str] = []
    try:
        async for evt in providers.stream_chat(messages, model_id, s):
            if evt.get("type") == "delta":
                text_parts.append(evt.get("text", ""))
            if evt.get("type") == "error":
                break
    except Exception:
        pass

    generated = "".join(text_parts).strip()
    # Strip accidental code fences.
    if generated.startswith("```"):
        # remove opening fence line
        generated = generated.split("\n", 1)[1] if "\n" in generated else ""
        if generated.endswith("```"):
            generated = generated.rsplit("```", 1)[0]
        generated = generated.strip()

    # Strict validation: must be a proper zwork.md-shaped output.
    if (
        not generated
        or len(generated) < 80
        or not generated.lstrip().lower().startswith("# zwork")
    ):
        return _fallback_zwork_md(user_name, qna_text, answers)
    return generated


def _fallback_zwork_md(user_name: str, qna_text: str, answers: list[OnboardAnswer]) -> str:
    # Pull common keys for a crisper fallback
    by_key = {a.key: a.answer for a in answers if a.answer}
    vibe = by_key.get("vibe", "Balanced")
    verbosity = by_key.get("verbosity", "Balanced")
    decisions = by_key.get("decisions", "Balanced")
    profession = by_key.get("profession", "")
    goal = by_key.get("goal", "")
    return f"""# zWork personalization

## About the user

- Name: {user_name}
- Profession: {profession or "(not specified)"}
- Long-term goal: {goal or "(not specified)"}

## Preferences

- Vibe: **{vibe}**
- Verbosity: **{verbosity}**
- Decision style: **{decisions}**

## How to talk to me

- Match the **{vibe}** tone — no filler, no over-explaining.
- Default reply length: **{verbosity}**.
- For multi-step work: {"walk me through each decision briefly" if "walk" in decisions.lower() else "just pick sensible defaults and act"}.
- Address me by my first name occasionally, never overdone.
- Prioritize action and shipping over meta-discussion.

---

## Raw onboarding answers (for reference)

{qna_text}
"""


def _write_onboarding_complete(answers: list[OnboardAnswer], user_name: str, zmd: Path) -> None:
    home_mod.onboarding_path().write_text(
        json.dumps(
            {
                "completed": True,
                "skipped": False,
                "display_name": user_name,
                "answers": [
                    {
                        "key": a.key,
                        "question": a.question,
                        "answer": a.answer,
                    }
                    for a in answers
                ],
                "zwork_md_path": str(zmd),
            }
        )
    )


@app.post("/api/onboard/complete")
async def onboard_complete(body: OnboardBody) -> dict:
    # Save any provider credential the user picked.
    if body.credential:
        s = settings_mod.load()
        cred = body.credential
        shape = cred.get("shape", "openai")
        credkey = cred.get("credential", "openai")
        api_key = cred.get("api_key", "")
        base_url = cred.get("base_url", "")
        model_id = cred.get("model_id", "")
        model_name = cred.get("model_name", model_id)

        if credkey == "openai" and providers.is_ollama_cloud_base(base_url):
            shape = "openai"
            base_url = providers.PREV1_OLLAMA_BASE_URL
            model_id = providers.PREV1_OLLAMA_MODEL_ID
            model_name = providers.PREV1_OLLAMA_MODEL_NAME

        if credkey in ("anthropic", "openai") and api_key:
            s.api_keys[credkey] = api_key
        if base_url:
            s.provider_config.setdefault(credkey, {})["base_url"] = base_url
        if model_id:
            m = settings_mod.upsert_custom_model(
                s,
                id=providers.PREV1_OLLAMA_ZWORK_ID if model_id == providers.PREV1_OLLAMA_MODEL_ID else None,
                name=model_name,
                shape=shape,
                credential=credkey,
                model_id=model_id,
                base_url_override=base_url if credkey == "openai" else "",
            )
            s.default_model = m.id
        settings_mod.save(s)

    # Build a zwork.md via LLM (or fallback) and save at repo root.
    user_name = _preferred_name_from_answers(body.answers) or _display_name()
    zmd = home_mod.zwork_md_path()
    zmd.parent.mkdir(parents=True, exist_ok=True)
    _write_onboarding_complete(body.answers, user_name, zmd)

    try:
        md = await _generate_zwork_md(body.answers, user_name)
    except Exception:
        qna_lines = [
            f"- {a.question}\n  → {a.answer}"
            for a in body.answers
            if a.answer and a.answer.strip()
        ]
        md = _fallback_zwork_md(user_name, "\n".join(qna_lines), body.answers)
    zmd.write_text(md, encoding="utf-8")

    _write_onboarding_complete(body.answers, user_name, zmd)
    return {"ok": True, "zwork_md_path": str(zmd), "preview": md}


@app.get("/api/integrations")
def integrations() -> dict:
    return {"integrations": [i.__dict__ for i in detect.detect_all()]}


@app.get("/api/providers")
def provider_status() -> dict:
    s = settings_mod.load()
    models = providers.available_models(s)
    default_model = s.default_model
    if not any(m["id"] == default_model for m in models):
        default_model = models[0]["id"] if models else ""
        if default_model:
            s.default_model = default_model
            settings_mod.save(s)
    return {
        "credentials": providers.credential_status(s),
        "models": models,
        "default_model": default_model,
    }


# ---------------- Settings ----------------

@app.get("/api/settings")
def get_settings() -> dict:
    return settings_mod.public_view(settings_mod.load())


@app.put("/api/settings")
def put_settings(patch: SettingsPatch) -> dict:
    s = settings_mod.load()
    if patch.api_keys is not None:
        merged = dict(s.api_keys)
        for k, v in patch.api_keys.items():
            if v is None or v == "":
                merged.pop(k, None)
            else:
                merged[k] = v
        s.api_keys = merged
    if patch.provider_config is not None:
        # Merge (don't blow away)
        merged_pc = {k: dict(v) for k, v in s.provider_config.items()}
        for k, v in patch.provider_config.items():
            cur = merged_pc.get(k) or {}
            for sk, sv in v.items():
                if sv == "":
                    cur.pop(sk, None)
                else:
                    cur[sk] = sv
            if cur:
                merged_pc[k] = cur
            else:
                merged_pc.pop(k, None)
        s.provider_config = merged_pc
    if patch.default_model is not None:
        s.default_model = patch.default_model
    if patch.use_claude_code_config is not None:
        s.use_claude_code_config = patch.use_claude_code_config
    settings_mod.save(s)
    return settings_mod.public_view(s)


# ---------------- Custom models ----------------

@app.get("/api/custom-models")
def list_custom_models() -> dict:
    return {"custom_models": settings_mod.load().custom_models}


@app.post("/api/custom-models")
def upsert_custom_model(body: CustomModelBody) -> dict:
    s = settings_mod.load()
    try:
        m = settings_mod.upsert_custom_model(
            s,
            id=body.id,
            name=body.name,
            shape=body.shape,
            credential=body.credential,
            model_id=body.model_id,
            base_url_override=body.base_url_override,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    settings_mod.save(s)
    return {"custom_models": s.custom_models, "id": m.id}


@app.delete("/api/custom-models/{model_id}")
def delete_custom_model(model_id: str) -> dict:
    s = settings_mod.load()
    ok = settings_mod.remove_custom_model(s, model_id)
    if not ok:
        raise HTTPException(404, "model not found")
    if s.default_model == model_id:
        s.default_model = ""
    settings_mod.save(s)
    return {"custom_models": s.custom_models}


# ---------------- Memory ----------------

@app.get("/api/memory")
def get_memory() -> dict:
    p = home_mod.memory_path()
    if not p.exists():
        return {"content": ""}
    return {"content": p.read_text(encoding="utf-8")}


@app.put("/api/memory")
def put_memory(body: ContentBody) -> dict:
    p = home_mod.memory_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.content, encoding="utf-8")
    return {"ok": True}


# ---------------- User MD (zwork.md) ----------------

@app.get("/api/user-md")
def get_user_md() -> dict:
    p = home_mod.zwork_md_path()
    if not p.exists():
        return {"content": ""}
    return {"content": p.read_text(encoding="utf-8")}


@app.put("/api/user-md")
def put_user_md(body: ContentBody) -> dict:
    p = home_mod.zwork_md_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.content, encoding="utf-8")
    return {"ok": True}


# ---------------- Uploads ----------------

@app.post("/api/uploads")
def upload_files(body: UploadBody) -> dict:
    uploads_dir = home_mod.workspace_uploads_dir()
    results: list[dict[str, Any]] = []
    for item in body.files:
        safe_name = Path(item.name or "upload").name
        suffix = Path(safe_name).suffix or mimetypes.guess_extension(item.mime or "") or ""
        stem = Path(safe_name).stem or "upload"
        out = uploads_dir / f"{stem}-{new_id('upload')}{suffix}"

        if item.text_content is not None:
            out.write_text(item.text_content, encoding="utf-8")
            size = len(item.text_content.encode("utf-8"))
        elif item.data_url:
            raw = item.data_url
            if raw.startswith("data:"):
                raw = raw.split(",", 1)[1] if "," in raw else ""
            try:
                data = base64.b64decode(raw, validate=False)
            except (ValueError, binascii.Error):
                data = b""
            out.write_bytes(data)
            size = len(data)
        else:
            out.write_text("", encoding="utf-8")
            size = 0

        results.append({
            "client_id": item.client_id,
            "name": safe_name,
            "path": str(out),
            "mime": item.mime,
            "kind": item.kind,
            "size": size,
        })
    return {"files": results}


# ---------------- Projects ----------------

@app.get("/api/projects")
def list_projects() -> dict:
    return {"projects": projects_mod.list_all()}


@app.post("/api/projects")
def create_project(body: ProjectCreate) -> dict:
    p = projects_mod.create(name=body.name, description=body.description)
    return {"project": p.__dict__}


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    p = projects_mod.get(project_id)
    if not p:
        raise HTTPException(404, "project not found")
    return {"project": p.__dict__}


@app.patch("/api/projects/{project_id}")
def update_project(project_id: str, body: ProjectUpdate) -> dict:
    kwargs = {}
    if body.name is not None:
        kwargs["name"] = body.name
    if body.description is not None:
        kwargs["description"] = body.description
    p = projects_mod.update(project_id, **kwargs)
    if not p:
        raise HTTPException(404, "project not found")
    return {"project": p.__dict__}


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str) -> dict:
    ok = projects_mod.delete(project_id)
    if not ok:
        raise HTTPException(404, "project not found")
    return {"ok": True}


@app.get("/api/projects/{project_id}/context")
def get_project_context(project_id: str) -> dict:
    p = projects_mod.get(project_id)
    if not p:
        raise HTTPException(404, "project not found")
    content = projects_mod.get_context(project_id) or ""
    return {"content": content}


@app.put("/api/projects/{project_id}/context")
def put_project_context(project_id: str, body: ContentBody) -> dict:
    ok = projects_mod.set_context(project_id, body.content)
    if not ok:
        raise HTTPException(404, "project not found")
    return {"ok": True}


# ---------------- Ollama model proxy ----------------

@app.get("/api/ollama/models")
async def ollama_models(base_url: str = "https://ollama.com/v1", api_key: str = "") -> dict:
    """Proxy Ollama's OpenAI-compatible `/v1/models` listing so the onboarding
    UI can show a dropdown. Returns `{models: [{id, name}], error?}`."""
    import httpx
    url = base_url.rstrip("/") + "/models"
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(url, headers=headers)
        if r.status_code >= 400:
            return {"models": [], "error": f"{r.status_code}: {r.text[:200]}"}
        data = r.json()
        items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(items, list):
            items = data.get("models") if isinstance(data, dict) else []
        models = []
        for it in items or []:
            if not isinstance(it, dict):
                continue
            mid = it.get("id") or it.get("name") or ""
            if not mid:
                continue
            models.append({"id": mid, "name": it.get("name") or mid})
        return {"models": models}
    except Exception as e:  # pragma: no cover
        return {"models": [], "error": str(e)}


# ---------------- Chats ----------------

@app.get("/api/chats")
def list_chats() -> dict:
    return {"chats": chatstore.list_all()}


@app.post("/api/chats")
def create_chat(body: ChatCreate) -> dict:
    c = chatstore.create(title=body.title, model=body.model)
    return _chat_public(c)


@app.get("/api/chats/{chat_id}")
def get_chat(chat_id: str) -> dict:
    c = chatstore.get(chat_id)
    if not c:
        raise HTTPException(404, "chat not found")
    return _chat_public(c)


@app.patch("/api/chats/{chat_id}")
def rename_chat(chat_id: str, body: ChatRename) -> dict:
    c = chatstore.rename(chat_id, body.title)
    if not c:
        raise HTTPException(404, "chat not found")
    return _chat_public(c)


@app.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str) -> dict:
    ok = chatstore.delete(chat_id)
    if not ok:
        raise HTTPException(404, "chat not found")
    return {"ok": True}


def _chat_public(c: chatstore.Chat) -> dict[str, Any]:
    return {
        "id": c.id,
        "title": c.title,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
        "model": c.model,
        "messages": [m.__dict__ for m in c.messages],
    }


# ---------------- Chat stream ----------------

def _resolve_model_id(requested: str | None, s: settings_mod.Settings) -> str | None:
    if requested and providers.lookup_model(requested, s):
        return requested
    if s.default_model and providers.lookup_model(s.default_model, s):
        return s.default_model
    # Auto-fallback to the first available model
    avail = providers.available_models(s)
    return avail[0]["id"] if avail else None


@app.post("/api/chat/stream")
async def chat_stream(req: StreamRequest):
    s = settings_mod.load()
    model_id = _resolve_model_id(req.model, s)

    # If no model is available, still create/reuse the chat and stream a friendly
    # setup error back — never 400 hard.
    chat = chatstore.get(req.chat_id) if req.chat_id else None
    if chat is None:
        chat = chatstore.create(title=req.new_chat_title or "New chat", model=model_id or "")
    chatstore.append_message(chat.id, "user", req.message)
    chat = chatstore.get(chat.id)
    assert chat is not None

    if not model_id:
        async def no_model_sse() -> Any:
            yield _sse({"type": "chat", "id": chat.id, "title": chat.title})
            msg = (
                "No model is configured yet. "
                "Open **Settings → Credentials** to add an API key, "
                "or enable local credential reuse if you have it installed."
            )
            yield _sse({"type": "status", "text": "Setup needed"})
            # Stream it as a delta so it appears in the assistant bubble
            for chunk_start in range(0, len(msg), 24):
                yield _sse({"type": "delta", "text": msg[chunk_start:chunk_start + 24]})
            chatstore.append_message(chat.id, "assistant", msg)
            yield _sse({"type": "needs_setup"})
            yield _sse({"type": "done"})
            yield _sse({"type": "end"})
        return StreamingResponse(no_model_sse(), media_type="text/event-stream")

    # Build a system prompt with live model identity
    model_meta = providers.lookup_model(model_id, s) or {}
    prompt = settings_mod.build_system_prompt(
        model_name=model_meta.get("model_id") or model_id,
        provider_name=(
            "local credentials" if model_meta.get("credential") == "claude_code"
            else model_meta.get("subtitle") or "a model provider"
        ),
        user_name=_display_name(),
        os_name=_os_pretty(),
        cwd=str(Path.cwd()),
    )

    attachment_block = ""
    if req.attachments:
        lines = ["## Current interaction context"]
        lines.append(f"Artifact mode: {'on' if req.artifact_mode else 'off'}")
        lines.append("Attachments uploaded into `~/.zwork/workspace/uploads`:")
        for a in req.attachments:
            lines.append(f"- {a.name} → {a.path}")
        attachment_block = "\n".join(lines)
    else:
        attachment_block = "\n".join([
            "## Current interaction context",
            f"Artifact mode: {'on' if req.artifact_mode else 'off'}",
            "Attachments: none.",
        ])
    prompt = f"{prompt}\n\n{attachment_block}\n\n## Artifact intent hint\n{_artifact_hint(req.message)}"

    history = [{"role": m.role, "content": m.content} for m in chat.messages]

    async def sse() -> Any:
        yield _sse({"type": "chat", "id": chat.id, "title": chat.title})
        full_text = ""
        try:
            async for evt in providers.stream_chat(
                [{"role": "system", "content": prompt}, *history],
                model_id,
                s,
            ):
                if evt.get("type") == "delta":
                    full_text += evt.get("text", "")
                yield _sse(evt)
        except Exception as e:  # pragma: no cover
            yield _sse({"type": "error", "text": str(e)})
        if full_text:
            chatstore.append_message(chat.id, "assistant", full_text)
        yield _sse({"type": "end"})

    return StreamingResponse(sse(), media_type="text/event-stream")


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


# ---- SPA catch-all: serve index.html for any non-API, non-static route ----
if _STATIC_DIR.is_dir():

    @app.get("/{path:path}")
    async def serve_spa(request: Request, path: str) -> HTMLResponse:
        # Try to serve a matching static file first (e.g. favicon, SVGs).
        candidate = _STATIC_DIR / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        # Fall back to index.html for SPA routing.
        return FileResponse(_STATIC_DIR / "index.html")


def main() -> None:
    import uvicorn
    host = os.environ.get("ZWORK_HOST", "127.0.0.1")
    port = int(os.environ.get("ZWORK_PORT", "8787"))
    print(f"zWork web app → http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
