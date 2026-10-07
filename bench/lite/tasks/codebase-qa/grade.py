import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import finish
try:
    a = json.load(open(pathlib.Path(sys.argv[1]) / "answers.json"))
except Exception as e:
    finish(False, f"answers.json unreadable: {e}")
errs = []
try:
    if abs(float(a.get("q1")) - 13.5) > 1e-6: errs.append(f"q1={a.get('q1')} (want 13.5)")
except Exception: errs.append(f"q1={a.get('q1')!r} not a number")
if str(a.get("q2", "")).strip() != "SVC_STORE_PATH": errs.append(f"q2={a.get('q2')!r}")
if " ".join(str(a.get("q3", "")).split()).upper() != "DELETE /ADMIN/EVENTS": errs.append(f"q3={a.get('q3')!r}")
finish(not errs, "; ".join(errs) or "ok")
