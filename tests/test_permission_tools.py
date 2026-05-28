"""Tests for ask_user and ask_user_for_permission tools."""
import asyncio
import pytest
from typing import Any

from sidecar.agent import tools


@pytest.mark.anyio
async def test_ask_user_flow(monkeypatch) -> None:
    # Set up chat id and mock current_run
    chat_id = "test_chat_123"
    
    class MockRun:
        def __init__(self):
            self.chat_id = chat_id
        def next_tool_call(self):
            pass
        def log(self, *args, **kwargs):
            pass

    monkeypatch.setattr(tools, "current_run", lambda: MockRun())
    tools.PENDING_QUESTIONS.clear()

    params = {
        "question": "Which style?",
        "options": ["editorial", "minimalist", "tech"],
    }

    # Execute the ask_user tool in a background task
    async def run_tool():
        events = []
        async for evt in tools.execute_tool("ask_user", params):
            events.append(evt)
        return events

    task = asyncio.create_task(run_tool())

    # Yield control to let the tool execution start and block on the event
    await asyncio.sleep(0.1)

    # Check that a question is registered in PENDING_QUESTIONS
    assert chat_id in tools.PENDING_QUESTIONS
    event, result_box = tools.PENDING_QUESTIONS[chat_id]

    # Simulate user answering the question
    result_box.append("minimalist")
    event.set()

    # Wait for tool execution task to finish
    events = await task

    # Assert that correct events were yielded
    activity_events = [e for e in events if e.get("type") == "activity"]
    tool_result_events = [e for e in events if e.get("type") == "tool_result"]
    ask_question_events = [e for e in events if e.get("type") == "ask_question"]

    assert len(ask_question_events) == 1
    assert ask_question_events[0]["question"] == "Which style?"
    assert ask_question_events[0]["options"] == ["editorial", "minimalist", "tech"]

    assert len(tool_result_events) == 1
    assert tool_result_events[0]["ok"] is True
    assert "User responded with: minimalist" in tool_result_events[0]["message"]


@pytest.mark.anyio
async def test_ask_user_for_permission_approve(monkeypatch) -> None:
    chat_id = "test_chat_456"
    
    class MockRun:
        def __init__(self):
            self.chat_id = chat_id
        def next_tool_call(self):
            pass
        def log(self, *args, **kwargs):
            pass

    monkeypatch.setattr(tools, "current_run", lambda: MockRun())
    tools.PENDING_QUESTIONS.clear()

    params = {
        "explanation": "deleting temp files to free space",
    }

    # Test Approve
    async def run_approve():
        events = []
        async for evt in tools.execute_tool("ask_user_for_permission", params):
            events.append(evt)
        return events

    task = asyncio.create_task(run_approve())
    await asyncio.sleep(0.1)

    assert chat_id in tools.PENDING_QUESTIONS
    event, result_box = tools.PENDING_QUESTIONS[chat_id]
    result_box.append("Approve")
    event.set()

    events = await task
    tool_result_events = [e for e in events if e.get("type") == "tool_result"]
    assert len(tool_result_events) == 1
    assert tool_result_events[0]["ok"] is True
    assert tool_result_events[0]["message"] == "Permission granted by user."


@pytest.mark.anyio
async def test_ask_user_for_permission_deny(monkeypatch) -> None:
    chat_id = "test_chat_789"
    
    class MockRun:
        def __init__(self):
            self.chat_id = chat_id
        def next_tool_call(self):
            pass
        def log(self, *args, **kwargs):
            pass

    monkeypatch.setattr(tools, "current_run", lambda: MockRun())
    tools.PENDING_QUESTIONS.clear()

    params = {
        "explanation": "formatting hard disk",
    }

    # Test Deny
    async def run_deny():
        events = []
        async for evt in tools.execute_tool("ask_user_for_permission", params):
            events.append(evt)
        return events

    task = asyncio.create_task(run_deny())
    await asyncio.sleep(0.1)

    assert chat_id in tools.PENDING_QUESTIONS
    event, result_box = tools.PENDING_QUESTIONS[chat_id]
    result_box.append("Deny")
    event.set()

    events = await task
    tool_result_events = [e for e in events if e.get("type") == "tool_result"]
    assert len(tool_result_events) == 1
    assert tool_result_events[0]["ok"] is False
    assert tool_result_events[0]["message"] == "Permission denied by user."


@pytest.mark.anyio
async def test_ask_user_for_permission_alternative(monkeypatch) -> None:
    chat_id = "test_chat_000"
    
    class MockRun:
        def __init__(self):
            self.chat_id = chat_id
        def next_tool_call(self):
            pass
        def log(self, *args, **kwargs):
            pass

    monkeypatch.setattr(tools, "current_run", lambda: MockRun())
    tools.PENDING_QUESTIONS.clear()

    params = {
        "explanation": "delete both ~/.npm and ~/Movies/CapCut",
    }

    # Test custom instruction / alternative path
    async def run_alternative():
        events = []
        async for evt in tools.execute_tool("ask_user_for_permission", params):
            events.append(evt)
        return events

    task = asyncio.create_task(run_alternative())
    await asyncio.sleep(0.1)

    assert chat_id in tools.PENDING_QUESTIONS
    event, result_box = tools.PENDING_QUESTIONS[chat_id]
    result_box.append("only delete Movies/CapCut, not npm cache")
    event.set()

    events = await task
    tool_result_events = [e for e in events if e.get("type") == "tool_result"]
    assert len(tool_result_events) == 1
    assert tool_result_events[0]["ok"] is False
    assert "only delete Movies/CapCut, not npm cache" in tool_result_events[0]["message"]


@pytest.mark.anyio
async def test_ask_user_for_permission_approve_command(monkeypatch) -> None:
    chat_id = "test_chat_cmd"
    
    class MockRun:
        def __init__(self):
            self.chat_id = chat_id
            self.approved_commands = set()
        def next_tool_call(self):
            pass
        def log(self, *args, **kwargs):
            pass

    mock_run = MockRun()
    monkeypatch.setattr(tools, "current_run", lambda: mock_run)
    tools.PENDING_QUESTIONS.clear()

    params = {
        "explanation": "delete the capcut folder",
        "command": "rm -rf ~/Movies/CapCut",
    }

    async def run_approve():
        events = []
        async for evt in tools.execute_tool("ask_user_for_permission", params):
            events.append(evt)
        return events

    task = asyncio.create_task(run_approve())
    await asyncio.sleep(0.1)

    assert chat_id in tools.PENDING_QUESTIONS
    event, result_box = tools.PENDING_QUESTIONS[chat_id]
    result_box.append("Approve")
    event.set()

    events = await task
    tool_result_events = [e for e in events if e.get("type") == "tool_result"]
    assert len(tool_result_events) == 1
    assert tool_result_events[0]["ok"] is True
    assert "rm -rf ~/Movies/CapCut" in tool_result_events[0]["message"]
    
    assert "rm -rf ~/Movies/CapCut" in mock_run.approved_commands
