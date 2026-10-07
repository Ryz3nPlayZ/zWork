import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import finish
d = pathlib.Path(sys.argv[1]) / "configs"
want = {
 "api.json": {"version": 2, "name": "api", "server": {"url": "https://api.internal"}, "timeout_ms": 30000, "retry": {"max": 5}, "tags": ["core", "web"]},
 "worker.json": {"version": 2, "name": "worker", "server": {"url": "http://10.0.0.5:8080"}, "timeout_ms": 2500, "retry": {"max": 3}, "tags": ["batch"]},
 "legacy.json": {"version": 2, "name": "legacy", "server": {"url": "http://old.example.com"}, "timeout_ms": 250, "retry": {"max": 0}, "tags": [], "extra": {"owner": "team-x", "pager": True}},
 "edge.json": {"version": 2, "name": "edge", "server": {"url": "https://edge.example.com:8443"}, "timeout_ms": 120000, "retry": {"max": 3}, "tags": []},
 "already.json": {"version": 2, "name": "already", "server": {"url": "http://x:81"}, "timeout_ms": 10, "retry": {"max": 1}, "tags": ["a"]},
 "slow.json": {"version": 2, "name": "slow", "server": {"url": "http://slow.example.com:443"}, "timeout_ms": 1500, "retry": {"max": 2}, "tags": []},
}
errs = []
names = sorted(p.name for p in d.glob("*.json"))
if names != sorted(want): errs.append(f"files {names}")
for k, v in want.items():
    try:
        got = json.load(open(d / k))
    except Exception as e:
        errs.append(f"{k}: {e}"); continue
    if got != v: errs.append(f"{k}: {json.dumps(got)} != {json.dumps(v)}")
finish(not errs, "; ".join(errs) or "ok")
