"""Tests for the tier-one harness changes:
  - project.md auto-injection into the system prompt
  - tool risk classification + plan-mode tool filter
  - context compaction shape (LLM call itself is mocked)
  - chatstore round-trips the new fields

These cover the deterministic seams. The actual LLM-call paths in
`compaction.summarize` are exercised by an injected stub.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from sidecar.agent import chatstore, compaction, settings as settings_mod, tools


# ---------------- system prompt: project.md injection ----------------


def test_build_system_prompt_omits_project_block_when_empty() -> None:
    prompt = settings_mod.build_system_prompt()
    assert "Project context" not in prompt


def test_build_system_prompt_includes_project_block_when_provided() -> None:
    prompt = settings_mod.build_system_prompt(
        project_name="acme-rebrand",
        project_md="- ship by Friday\n- no purple",
    )
    assert "Project context — acme-rebrand" in prompt
    assert "ship by Friday" in prompt
    assert "no purple" in prompt


def test_build_system_prompt_plan_mode_block() -> None:
    on = settings_mod.build_system_prompt(plan_mode=True)
    off = settings_mod.build_system_prompt(plan_mode=False)
    assert "Plan mode is ACTIVE" in on
    assert "Plan mode is ACTIVE" not in off
    # Read-only tool names should be mentioned so the model knows what's left.
    assert "read_file" in on


def test_build_system_prompt_permission_block_default_on() -> None:
    locked = settings_mod.build_system_prompt(auto_approve_destructive=False)
    open_ = settings_mod.build_system_prompt(auto_approve_destructive=True)
    assert "User confirmation required for destructive actions" in locked
    assert "User confirmation required for destructive actions" not in open_


# ---------------- tool risk classifier ----------------


@pytest.mark.parametrize("tool_name", list(tools.READ_ONLY_TOOLS))
def test_read_only_tools_classify_safe(tool_name: str) -> None:
    assert tools.tool_risk(tool_name, {})[0] == "safe"


@pytest.mark.parametrize(
    "command",
    [
        "rm -rf /tmp/something",
        "sudo rm -rf ~/Documents",
        "rm -fr /var/data",
        "mkfs.ext4 /dev/sdb1",
        "dd if=/dev/zero of=/dev/sda bs=1M",
        "git push --force origin main",
        "git push -f",
        "git reset --hard HEAD~5",
        "git clean -fd",
        "git branch -D feature/old",
        "DROP TABLE users;",
        "drop database production",
        "shutdown -h now",
        "reboot",
    ],
)
def test_destructive_commands_flagged(command: str) -> None:
    risk, reason = tools.tool_risk("run_command", {"command": command})
    assert risk == "destructive", f"missed destructive: {command} (got {reason})"


@pytest.mark.parametrize(
    "command",
    [
        "ls -la",
        "git status",
        "npm install",
        "python3 build.py",
        "cargo build --release",
        "rm /tmp/single-file.txt",  # non-recursive single file is sensitive, not destructive
    ],
)
def test_non_destructive_commands_not_flagged_destructive(command: str) -> None:
    risk, _ = tools.tool_risk("run_command", {"command": command})
    assert risk != "destructive"


def test_dctl_subcommands_have_split_risk() -> None:
    safe, _ = tools.tool_risk("dctl", {"subcommand": "snapshot"})
    sensitive, _ = tools.tool_risk("dctl", {"subcommand": "click"})
    assert safe == "safe"
    assert sensitive == "sensitive"


# ---------------- plan-mode tool filter ----------------


def test_filter_tools_for_plan_mode_keeps_only_read_only() -> None:
    filtered = tools.filter_tools_for_plan_mode(tools.TOOL_SCHEMAS)
    names = {t["name"] for t in filtered}
    assert names == set(tools.READ_ONLY_TOOLS)
    assert "write_file" not in names
    assert "run_command" not in names


# ---------------- compaction: deterministic shape ----------------


def _msg(role: str, text: str) -> dict:
    return {"role": role, "content": text}


def test_estimate_chars_handles_string_and_block_content() -> None:
    msgs = [
        _msg("user", "hello"),
        {"role": "assistant", "content": [
            {"type": "text", "text": "world"},
            {"type": "tool_result", "content": "ok"},
        ]},
    ]
    # "hello" + ("world" + "\n" + "ok") = 5 + 8 = 13 chars (block parts joined by \n)
    assert compaction.estimate_chars(msgs) == 13


def test_should_compact_false_when_below_threshold() -> None:
    msgs = [_msg("user", "x" * 100), _msg("assistant", "y" * 100)]
    assert compaction.should_compact(msgs, threshold_chars=10_000) is False


def test_should_compact_false_when_too_few_messages() -> None:
    msgs = [_msg("user", "x" * 200_000), _msg("assistant", "y" * 200_000)]
    # Past threshold but only 2 messages — nothing meaningful to compact.
    assert compaction.should_compact(msgs, threshold_chars=10_000, keep_recent=4) is False


def test_should_compact_true_when_over_threshold_with_history() -> None:
    msgs = [_msg("user", "x" * 30_000) for _ in range(10)]
    assert compaction.should_compact(msgs, threshold_chars=120_000, keep_recent=4) is True


def test_plan_compaction_keeps_tail_verbatim() -> None:
    msgs = [_msg("user", f"msg {i}") for i in range(10)]
    plan = compaction.plan_compaction(msgs, keep_recent=3)
    assert plan.keep_head == []
    assert len(plan.middle) == 7
    assert plan.keep_tail == msgs[-3:]
    assert plan.cursor == 7


def test_render_summary_message_marks_compaction() -> None:
    msg = compaction.render_summary_message("the user wanted X")
    assert msg["role"] == "assistant"
    assert "compacted" in msg["content"].lower()
    assert "the user wanted X" in msg["content"]


# ---------------- compaction: end-to-end with stubbed LLM ----------------


def test_summarize_uses_anthropic_shape_when_shape_anthropic(monkeypatch) -> None:
    """`summarize` must dispatch to the right shape branch and parse the
    expected response envelope. We stub httpx to keep this offline."""
    import asyncio

    from sidecar.agent import providers

    captured: dict = {}

    class _Resp:
        status_code = 200
        def raise_for_status(self) -> None: pass
        def json(self) -> dict:
            return {"content": [{"type": "text", "text": "SUMMARIZED"}]}

    class _Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, json=None, headers=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["body"] = json
            return _Resp()

    monkeypatch.setattr(compaction.httpx, "AsyncClient", _Client)

    creds = providers.Credentials(
        shape="anthropic", api_key="sk-ant-test", base_url="https://api.anthropic.com",
        source="byok",
    )
    out = asyncio.run(compaction.summarize(
        [_msg("user", "do X"), _msg("assistant", "ok done")],
        creds=creds,
        model_id="claude-sonnet-4-5",
        shape="anthropic",
    ))
    assert out == "SUMMARIZED"
    assert captured["url"].endswith("/v1/messages")
    assert captured["headers"]["x-api-key"] == "sk-ant-test"
    assert captured["body"]["model"] == "claude-sonnet-4-5"
    # Should pass our system prompt verbatim
    assert "summarizing the earlier portion" in captured["body"]["system"]


# ---------------- chatstore: new persisted fields round-trip ----------------


def test_chatstore_persists_project_id_and_compaction(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(chatstore, "chats_dir", lambda: tmp_path)
    c = chatstore.create(title="t", project_id="proj-123")
    chatstore.append_message(c.id, "user", "first")
    chatstore.append_message(c.id, "assistant", "reply")
    chatstore.set_compaction(c.id, "earlier turns…", cursor=2)

    reloaded = chatstore.get(c.id)
    assert reloaded is not None
    assert reloaded.project_id == "proj-123"
    assert reloaded.compacted_summary == "earlier turns…"
    assert reloaded.compaction_cursor == 2


def test_chatstore_set_project_updates_existing_chat(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(chatstore, "chats_dir", lambda: tmp_path)
    c = chatstore.create(title="t")
    assert c.project_id == ""
    chatstore.set_project(c.id, "proj-xyz")
    reloaded = chatstore.get(c.id)
    assert reloaded is not None
    assert reloaded.project_id == "proj-xyz"


def test_chatstore_loads_legacy_chat_without_new_fields(tmp_path, monkeypatch) -> None:
    """Existing chats on disk predate the new fields — they must still load."""
    monkeypatch.setattr(chatstore, "chats_dir", lambda: tmp_path)
    legacy = {
        "id": "abc123",
        "title": "old",
        "created_at": 1000,
        "updated_at": 1000,
        "messages": [],
        "model": "claude-sonnet-4-5",
    }
    (tmp_path / "abc123.json").write_text(json.dumps(legacy))
    c = chatstore.get("abc123")
    assert c is not None
    assert c.project_id == ""
    assert c.compacted_summary == ""
    assert c.compaction_cursor == 0
