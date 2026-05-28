"""Tests for background agent execution, reconnection, and manual stop cancellation using a real local uvicorn server thread."""
import asyncio
import socket
import threading
import time
import pytest
import httpx
from unittest.mock import patch

from sidecar import server


def get_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def local_server():
    port = get_free_port()
    import uvicorn
    config = uvicorn.Config(
        server.app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )
    uvicorn_server = uvicorn.Server(config)
    
    # Run the server in a background thread
    thread = threading.Thread(target=uvicorn_server.run)
    thread.daemon = True
    thread.start()
    
    # Wait for uvicorn to start up by polling the TCP port
    start_time = time.time()
    for _ in range(50):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                break
        except OSError:
            time.sleep(0.1)
    else:
        raise RuntimeError("Local uvicorn server failed to start in 5 seconds")
    
    yield f"http://127.0.0.1:{port}"
    
    # Shutdown the server
    uvicorn_server.should_exit = True
    thread.join(timeout=2.0)


@patch("sidecar.server.providers.stream_chat")
@patch("sidecar.server._resolve_model_id")
@patch("sidecar.server.providers.lookup_model")
def test_reconnection_flow(mock_lookup_model, mock_resolve_model_id, mock_stream_chat, local_server) -> None:
    mock_resolve_model_id.return_value = "mock-model"
    mock_lookup_model.return_value = {
        "model_id": "mock-model",
        "credential": "mock-cred",
        "shape": "anthropic",
    }
    server.ACTIVE_RUNS.clear()

    # Set up a mock async generator for stream_chat
    async def mock_stream(*args, **kwargs):
        yield {"type": "delta", "text": "Hello"}
        await asyncio.sleep(0.5)
        yield {"type": "delta", "text": " World"}
        await asyncio.sleep(0.5)
        yield {"type": "done"}

    mock_stream_chat.side_effect = mock_stream

    # 1. Start the first stream request
    with httpx.stream(
        "POST",
        f"{local_server}/api/chat/stream",
        json={
            "chat_id": None,
            "message": "test message",
            "model": "mock-model",
        },
    ) as response1:
        assert response1.status_code == 200

        # Read the first event from the response stream
        for line in response1.iter_lines():
            if line:
                break  # Disconnect immediately after receiving the first event!

    # Since the connection was closed, check that the run is active in ACTIVE_RUNS
    # The background task should still be running because it is decoupled from request cancellation
    assert len(server.ACTIVE_RUNS) == 1
    chat_id = list(server.ACTIVE_RUNS.keys())[0]

    # 2. Reconnect to the stream
    with httpx.stream(
        "POST",
        f"{local_server}/api/chat/stream",
        json={
            "chat_id": chat_id,
            "message": "test message",
            "model": "mock-model",
        },
    ) as response2:
        assert response2.status_code == 200

        # Read all events from the reconnected stream
        events = []
        for line in response2.iter_lines():
            if line:
                events.append(line)

    # Verify that we got the remaining tokens ("World")
    assert any("World" in e for e in events)

    # Let's wait a moment and verify that ACTIVE_RUNS is cleaned up after queue is drained
    time.sleep(0.2)
    assert chat_id not in server.ACTIVE_RUNS


@patch("sidecar.server.providers.stream_chat")
@patch("sidecar.server._resolve_model_id")
@patch("sidecar.server.providers.lookup_model")
def test_manual_stop(mock_lookup_model, mock_resolve_model_id, mock_stream_chat, local_server) -> None:
    mock_resolve_model_id.return_value = "mock-model"
    mock_lookup_model.return_value = {
        "model_id": "mock-model",
        "credential": "mock-cred",
        "shape": "anthropic",
    }
    server.ACTIVE_RUNS.clear()

    # Mock stream that sleeps to allow cancellation
    async def mock_stream(*args, **kwargs):
        yield {"type": "delta", "text": "Start"}
        try:
            await asyncio.sleep(5.0)
            yield {"type": "delta", "text": "End"}
        except asyncio.CancelledError:
            raise

    mock_stream_chat.side_effect = mock_stream

    with httpx.stream(
        "POST",
        f"{local_server}/api/chat/stream",
        json={
            "chat_id": None,
            "message": "test stop",
            "model": "mock-model",
        },
    ) as response:
        assert response.status_code == 200

        # Read the first event to ensure the background task has started and registered
        for line in response.iter_lines():
            if line:
                break

        # Get chat id
        assert len(server.ACTIVE_RUNS) == 1
        chat_id = list(server.ACTIVE_RUNS.keys())[0]

        # Invoke the stop endpoint
        stop_response = httpx.post(f"{local_server}/api/chats/{chat_id}/stop")
        assert stop_response.status_code == 200
        assert stop_response.json() == {"ok": True}

    # Verify that the active run registry has removed it
    assert chat_id not in server.ACTIVE_RUNS
