import csv, re, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import finish

w = pathlib.Path(sys.argv[1])
# Dune Studio's un-numbered 275.50 pays INV-1005, its only open invoice for that amount.
want = [
    ("INV-1003", "cobalt ltd", 1500.00, 40),
    ("INV-1006", "birch & co", 450.00, 14),
    ("INV-1007", "elm partners", 990.00, 0),
    ("INV-1008", "cobalt ltd", 600.00, 0),
    ("INV-1010", "dune studio", 310.00, 0),
]
errs = []
try:
    with open(w / "unpaid.csv", newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.reader(f) if any(c.strip() for c in r)]
except OSError as e:
    finish(False, f"unpaid.csv: {e}")
if not rows or [c.strip().lower() for c in rows[0]] != ["invoice", "client", "amount_due", "days_overdue"]:
    errs.append(f"header {rows[:1]}")
got = []
for r in rows[1:]:
    try:
        got.append((r[0].strip().upper(), r[1].strip().lower(), round(float(r[2].replace(",", "").replace("$", "")), 2), int(float(r[3]))))
    except (ValueError, IndexError):
        errs.append(f"bad row {r}")
if sorted(got) != sorted(want):
    errs.append(f"rows {got} != {want}")
elif got != want:
    errs.append(f"order {[g[0] for g in got]} != {[x[0] for x in want]}")

rem = w / "reminders"
names = sorted(p.name for p in rem.glob("*")) if rem.is_dir() else []
if names != ["INV-1003.txt", "INV-1006.txt"]:
    errs.append(f"reminders {names} != ['INV-1003.txt', 'INV-1006.txt']")
for inv, client, amt in [("INV-1003", "Cobalt", "1500.00"), ("INV-1006", "Birch", "450.00")]:
    p = rem / f"{inv}.txt"
    if not p.exists():
        continue
    t = p.read_text(encoding="utf-8").replace(",", "")
    if inv not in t:
        errs.append(f"{p.name} doesn't name the invoice")
    if amt not in t and amt.rstrip("0").rstrip(".") not in re.findall(r"\d+(?:\.\d+)?", t):
        errs.append(f"{p.name} doesn't give the amount {amt}")
    if client.lower() not in t.lower():
        errs.append(f"{p.name} isn't addressed to {client}")
finish(not errs, "; ".join(errs) or "ok")
