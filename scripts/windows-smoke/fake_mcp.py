"""Tiny stdio MCP server for the smoke test.

It writes its PID to $SMOKE_MCP_PID_FILE and, like some real servers, keeps
running after its stdin closes, so the test can tell whether zWork actually
stops it when the connector is removed.
"""
import json
import os
import sys
import time

with open(os.environ["SMOKE_MCP_PID_FILE"], "w") as f:
    f.write(str(os.getpid()))

for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if "id" not in msg:
        continue
    method = msg.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                  "serverInfo": {"name": "smoke", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "ping", "description": "Answers pong.",
                             "inputSchema": {"type": "object", "properties": {}}}]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": "pong"}]}
    else:
        result = {}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()

time.sleep(600)
