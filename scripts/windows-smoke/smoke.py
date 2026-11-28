"""Scripted smoke test of the zWork backend, written for the Windows CI runner
(it also runs on macOS/Linux for local checking).

It starts the real backend binary against a throwaway home folder whose path
has a space in it, with a fake OpenAI-compatible model server in this process,
and checks, end to end:

  1. the backend starts and answers its health check
  2. a connector (stdio MCP server) connects, and removing it stops the process
  3. one chat turn: the model runs a command with very long output, then
     streams a very long reply; the turn finishes and the chat is saved
  4. no shell processes are left behind once the turn is over
  5. after the backend is killed and started again, the chat is still there
  6. Send logs posts the logs (without the access token or the user's home
     folder) and returns the code

Usage: python smoke.py <path to rwork-backend[.exe]> <output dir>
Exits non-zero on the first failed check; every check is printed.
"""
import json
import re
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WINDOWS = os.name == "nt"
HERE = Path(__file__).resolve().parent
REPLY_CHUNKS = 4000          # ~24k words streamed in the final reply
CMD_LINES = 30000            # lines the command prints
END_MARK = "SMOKE-REPLY-END"
CMD_MARK = "SMOKE-CMD-DONE"
TOKEN = "smoke-token"

if WINDOWS:
    LONG_COMMAND = f'1..{CMD_LINES} | ForEach-Object {{ "row $_ of the long output test" }}; "{CMD_MARK}"'
else:
    LONG_COMMAND = f'for i in $(seq 1 {CMD_LINES}); do echo "row $i of the long output test"; done; echo {CMD_MARK}'

results = []
received_logs = {}


def gaps(text):
    """Which of the reply's numbered parts are missing, for diagnosing loss."""
    seen = {int(n) for n in re.findall(r"Part (\d+) of a long", text)}
    missing = [i for i in range(REPLY_CHUNKS) if i not in seen]
    return f"{len(missing)} parts missing" + (f" (first {missing[:5]}, last {missing[-3:]})" if missing else "")


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)
    if not ok:
        raise SystemExit(1)


# ── fake model server ───────────────────────────────────────────────────────

class FakeLLM(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._json(200, {"data": [{"id": "smoke-model", "object": "model"}], "models": []})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            req = json.loads(raw or b"{}")
        except ValueError:
            req = {}
        if self.path.endswith("/logs/report"):
            received_logs["body"] = raw.decode("utf-8", "replace")
            received_logs["auth"] = self.headers.get("Authorization", "")
            return self._json(200, {"code": "ZW-SMOKE1"})
        if not self.path.endswith("/chat/completions"):
            return self._json(404, {"error": "not here"})

        msgs = req.get("messages", [])
        has_tools = bool(req.get("tools"))
        tool_done = any(m.get("role") == "tool" for m in msgs)
        if not req.get("stream"):
            return self._json(200, {"id": "x", "object": "chat.completion", "choices": [
                {"index": 0, "message": {"role": "assistant", "content": "Smoke chat"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def send(delta=None, finish=None, usage=None):
            chunk = {"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "smoke-model",
                     "choices": [] if usage else [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}
            if usage:
                chunk["usage"] = usage
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())

        try:
            if has_tools and not tool_done:
                send({"role": "assistant", "content": "Running the command now."})
                args = json.dumps({"command": LONG_COMMAND})
                send({"tool_calls": [{"index": 0, "id": "call_smoke_1", "type": "function",
                                      "function": {"name": "bash", "arguments": ""}}]})
                for i in range(0, len(args), 40):
                    send({"tool_calls": [{"index": 0, "function": {"arguments": args[i:i + 40]}}]})
                send(finish="tool_calls")
            elif has_tools:
                send({"role": "assistant", "content": ""})
                for i in range(REPLY_CHUNKS):
                    send({"content": f"Part {i} of a long streamed answer. "})
                    if i % 200 == 0:
                        self.wfile.flush()
                        time.sleep(0.01)
                send({"content": END_MARK})
                send(finish="stop")
            else:
                send({"role": "assistant", "content": "Smoke chat"})
                send(finish="stop")
            send(usage={"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


# ── helpers ─────────────────────────────────────────────────────────────────

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def api(base, method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"x-zwork-token": TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except ValueError:
            return e.code, None


def pid_alive(pid):
    if WINDOWS:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def children_of(pid):
    """Names of processes whose parent is `pid`."""
    if WINDOWS:
        ps = (f"Get-CimInstance Win32_Process -Filter 'ParentProcessId={pid}' | "
              "ForEach-Object { $_.Name }")
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True).stdout
    else:
        out = subprocess.run(["pgrep", "-l", "-P", str(pid)], capture_output=True, text=True).stdout
    return [line.strip() for line in out.splitlines() if line.strip()]


def kill_tree(proc):
    if proc.poll() is not None:
        return
    if WINDOWS:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.kill()
    proc.wait(timeout=20)


def start_backend(binary, home, work, port, log):
    env = {**os.environ, "ZWORK_HOME": str(home), "ZWORK_PORT": str(port), "ZWORK_HOST": "127.0.0.1",
           "ZWORK_SIDECAR_TOKEN": TOKEN, "RUST_LOG": "warn,rwork_backend=info,harness=info",
           "SMOKE_MCP_PID_FILE": str(home / "mcp.pid")}
    flags = 0x0800_0000 if WINDOWS else 0  # what the desktop app does: no console
    proc = subprocess.Popen([str(binary)], cwd=work, env=env, stdout=log, stderr=log, creationflags=flags)
    base = f"http://127.0.0.1:{port}"
    started = time.monotonic()
    while time.monotonic() - started < 90:
        if proc.poll() is not None:
            break
        try:
            if api(base, "GET", "/api/health", timeout=3)[0] == 200:
                return proc, base, time.monotonic() - started
        except OSError:
            pass
        time.sleep(0.25)
    return proc, None, time.monotonic() - started


# ── the test ────────────────────────────────────────────────────────────────

def main():
    binary = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve()
    out.mkdir(parents=True, exist_ok=True)

    llm = ThreadingHTTPServer(("127.0.0.1", free_port()), FakeLLM)
    threading.Thread(target=llm.serve_forever, daemon=True).start()
    llm_base = f"http://127.0.0.1:{llm.server_address[1]}/v1"

    # A space in the path, like C:\Users\Jane Doe\...
    root = Path(tempfile.mkdtemp(prefix="zwork smoke "))
    home = root / "zwork home"
    work = root / "work folder"
    home.mkdir()
    work.mkdir()
    (home / "settings.json").write_text(json.dumps({
        "default_model": "smoke",
        "custom_models": [{"id": "smoke", "name": "Smoke", "shape": "openai", "credential": "ollama",
                           "model_id": "smoke-model", "base_url_override": llm_base}],
        "provider_config": {"zwork_router": {"base_url": llm_base}},
        "use_claude_code_config": False,
        "telemetry_enabled": False,
    }))

    port = free_port()
    log = open(out / "backend.log", "w")
    proc, base, took = start_backend(binary, home, work, port, log)
    try:
        check("backend starts and answers health", base, f"{took:.1f}s")

        # 2. connector process starts and is stopped on removal
        status, body = api(base, "POST", "/api/mcp/servers", {
            "name": "smoke", "config": {"command": sys.executable, "args": [str(HERE / "fake_mcp.py")]}}, timeout=60)
        ok = status == 200 and body and body.get("results") and body["results"][0].get("ok")
        check("connector connects", ok, json.dumps(body)[:300])
        mcp_pid = int((home / "mcp.pid").read_text())
        check("connector process running", pid_alive(mcp_pid), f"pid {mcp_pid}")
        api(base, "DELETE", "/api/mcp/servers/smoke")
        deadline = time.monotonic() + 15
        while pid_alive(mcp_pid) and time.monotonic() < deadline:
            time.sleep(0.25)
        check("removing the connector stops its process", not pid_alive(mcp_pid))

        # 3. one long turn
        body = json.dumps({"run_id": "smoke-run-1", "message": "Run the long command, then explain.",
                           "model": "smoke", "new_chat_title": "smoke", "plan_mode": False,
                           "auto_approve_destructive": True, "artifact_mode": False,
                           "web_search_enabled": False, "attachments": []}).encode()
        req = urllib.request.Request(base + "/api/chat/stream", data=body, method="POST",
                                     headers={"x-zwork-token": TOKEN, "Content-Type": "application/json"})
        counts, text, chat_id, tool_result, errors = {}, "", None, None, []
        started = time.monotonic()
        with open(out / "events.jsonl", "w", encoding="utf-8") as events, \
                urllib.request.urlopen(req, timeout=300) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    ev = json.loads(line[5:].strip())
                except ValueError:
                    continue
                t = ev.get("type")
                counts[t] = counts.get(t, 0) + 1
                if t != "delta":
                    events.write(json.dumps(ev)[:2000] + "\n")
                if t == "delta":
                    text += ev.get("text", "")
                elif t == "chat":
                    chat_id = ev.get("id")
                elif t == "tool_result":
                    tool_result = ev
                elif t == "error":
                    errors.append(ev)
                elif t == "end":
                    break
        took = time.monotonic() - started
        print("event counts:", json.dumps(counts), flush=True)
        check("turn has no errors", not errors, json.dumps(errors)[:500])
        check("model ran the command", counts.get("tool_use", 0) >= 1)
        msg = (tool_result or {}).get("message", "")
        check("command with long output finished", tool_result and tool_result.get("ok") and CMD_MARK in msg,
              f"{len(msg)} chars back, ok={tool_result and tool_result.get('ok')}")
        check("live command updates stayed small", counts.get("status", 0) < 2000, f"{counts.get('status', 0)} status events")
        (out / "reply.txt").write_text(text, encoding="utf-8")
        status, chat = api(base, "GET", f"/api/chats/{chat_id}")
        saved = json.dumps(chat or {})
        check("long reply streamed to the end", text.endswith(END_MARK),
              f"{len(text)} chars in {took:.1f}s; streamed {gaps(text)}; saved {gaps(saved)}")
        check("turn finished in time", took < 240, f"{took:.1f}s")
        check("turn reported done", counts.get("done", 0) >= 1)

        # 4. nothing left running under the backend
        time.sleep(1)
        kids = [k for k in children_of(proc.pid) if "conhost" not in k.lower()]
        check("no shell left running after the turn", not any("powershell" in k.lower() or k.lower().startswith("bash") for k in kids),
              f"children: {kids}")

        check("chat saved with the full reply", status == 200 and END_MARK in saved, f"chat {chat_id}")
        leftovers = [p.name for p in (home / "chats").glob("*.tmp")] if (home / "chats").exists() else []
        check("no half-written save files left", not leftovers, str(leftovers))

        # 5. kill and restart, like the desktop app's watchdog does
        kill_tree(proc)
        proc, base, took = start_backend(binary, home, work, port, log)
        check("backend restarts on the same port", base, f"{took:.1f}s")
        status, chat = api(base, "GET", f"/api/chats/{chat_id}")
        check("chat still there after restart", status == 200 and END_MARK in json.dumps(chat or {}))

        # 6. Send logs
        status, body = api(base, "POST", "/api/logs/send", {}, timeout=90)
        check("Send logs returns a code", status == 200 and (body or {}).get("code") == "ZW-SMOKE1", json.dumps(body))
        sent = received_logs.get("body", "")
        names = [f.get("name") for f in json.loads(sent).get("files", [])] if sent else []
        check("logs include backend files", bool(names), str(names))
        check("logs leave out the access token", TOKEN not in sent)
        user_home = str(Path.home())
        check("logs leave out the home folder path", user_home not in sent and json.dumps(user_home)[1:-1] not in sent)
    finally:
        kill_tree(proc)
        log.close()
        llm.shutdown()
        (out / "results.json").write_text(json.dumps([{"check": n, "ok": o, "detail": d} for n, o, d in results], indent=1))
        if (home / "logs").exists():
            shutil.copytree(home / "logs", out / "home-logs", dirs_exist_ok=True)
        shutil.rmtree(root, ignore_errors=True)
    print(f"\nall {len(results)} checks passed", flush=True)


if __name__ == "__main__":
    main()
