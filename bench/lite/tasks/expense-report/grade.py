import csv, re, sys, pathlib, unicodedata
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import finish

w = pathlib.Path(sys.argv[1])


def norm(s):
    s = unicodedata.normalize("NFKD", s.strip().lower())
    return "".join(c for c in s if not unicodedata.combining(c))


# (vendor, category, amount) -> accepted dates. The hotel folio shows both the
# arrival and the payment date, and the prompt doesn't pick one.
want = {
    ("blue bottle coffee", "meals", 10.53): {"2026-03-02"},
    ("delta air lines", "travel", 468.40): {"2026-03-03"},
    ("lyft", "travel", 27.10): {"2026-03-03"},
    ("sakura sushi", "meals", 246.40): {"2026-03-04"},
    ("hilton garden inn", "lodging", 646.38): {"2026-03-06", "2026-03-03"},
    ("staples", "office", 89.82): {"2026-03-10"},
    ("cafe de flore", "meals", 9.72): {"2026-03-18"},
    ("hotel lutetia", "lodging", 457.80): {"2026-03-19"},
    ("amazon", "office", 39.99): {"2026-03-20"},
}
errs = []
try:
    with open(w / "expenses.csv", newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
except OSError as e:
    finish(False, f"expenses.csv: {e}")
if not rows or [norm(c) for c in rows[0]] != ["date", "vendor", "category", "amount"]:
    errs.append(f"header {rows[:1]}")
got = {}
dates = []
for r in rows[1:]:
    if not any(c.strip() for c in r):
        continue
    if len(r) != 4:
        errs.append(f"bad row {r}")
        continue
    try:
        amt = round(float(r[3].replace("$", "").replace(",", "").strip()), 2)
    except ValueError:
        errs.append(f"bad amount {r}")
        continue
    if not re.fullmatch(r"\d+\.\d\d", r[3].replace("$", "").replace(",", "").strip()):
        errs.append(f"amount not 2 decimals: {r[3]}")
    key = (norm(r[1]), norm(r[2]), amt)
    got[key] = got.get(key, 0) + 1
    dates.append(r[0].strip())
    if key in want and r[0].strip() not in want[key]:
        errs.append(f"wrong date for {r}")
missing = [k for k in want if k not in got]
extra = [k for k in got if k not in want]
dupes = [k for k, n in got.items() if n > 1]
if missing:
    errs.append(f"missing {missing}")
if extra:
    errs.append(f"should not be claimed {extra}")
if dupes:
    errs.append(f"claimed twice {dupes}")
if dates != sorted(dates):
    errs.append("not sorted by date")

try:
    summary = (w / "summary.md").read_text(encoding="utf-8")
    flat = summary.replace(",", "")
    for label, total in [("meals", "266.65"), ("travel", "495.50"), ("lodging", "1104.18"), ("office", "129.81"), ("grand", "1996.14")]:
        if total not in flat:
            errs.append(f"summary lacks {label} total {total}")
except OSError as e:
    errs.append(f"summary.md: {e}")
finish(not errs, "; ".join(errs) or "ok")
