import csv, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import finish

w = pathlib.Path(sys.argv[1])
want = [
    ("alice", 40.0, 4.0, 1472.00),
    ("bob", 39.5, 0.0, 1125.75),
    ("carla", 40.0, 5.5, 1978.25),
    ("dev", 40.0, 5.0, 1710.00),
]
errs = []
try:
    with open(w / "payroll.csv", newline="", encoding="utf-8-sig") as f:
        rows = [[c.strip() for c in r] for r in csv.reader(f) if any(c.strip() for c in r)]
except OSError as e:
    finish(False, f"payroll.csv: {e}")
if not rows or [c.lower() for c in rows[0]] != ["employee", "regular_hours", "overtime_hours", "gross_pay"]:
    errs.append(f"header {rows[:1]}")
got = []
for r in rows[1:]:
    try:
        got.append((r[0].lower(), float(r[1]), float(r[2]), float(r[3].replace(",", "").replace("$", ""))))
    except (ValueError, IndexError):
        errs.append(f"bad row {r}")
if [g[0] for g in got] != [x[0] for x in want]:
    errs.append(f"employees {[g[0] for g in got]} != {[x[0] for x in want]}")
for g, x in zip(got, want):
    if any(abs(a - b) > 0.005 for a, b in zip(g[1:], x[1:])):
        errs.append(f"{g} != {x}")
finish(not errs, "; ".join(errs) or "ok")
