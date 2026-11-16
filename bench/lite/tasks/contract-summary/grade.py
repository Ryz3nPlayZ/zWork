import json, re, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import finish

w = pathlib.Path(sys.argv[1])
errs = []
try:
    d = json.loads((w / "contract-summary.json").read_text(encoding="utf-8"))
except (OSError, ValueError) as e:
    finish(False, f"contract-summary.json: {e}")


def num(v):
    try:
        return float(str(v).replace(",", "").replace("$", "").replace("%", "").replace("USD", "").strip())
    except ValueError:
        return None


checks = [
    ("client", lambda v: "northwind" in str(v).lower() and "brightline" not in str(v).lower()),
    ("provider", lambda v: "brightline" in str(v).lower()),
    ("start_date", lambda v: str(v).strip() == "2026-02-01"),
    ("auto_renews", lambda v: v is True or str(v).lower() == "true"),
    ("renewal_notice_days", lambda v: num(v) == 60),
    ("termination_notice_days", lambda v: num(v) == 90),
    ("current_monthly_fee", lambda v: num(v) == 2100),
    ("late_interest_percent_per_month", lambda v: num(v) == 1),
    ("payment_due_days", lambda v: num(v) == 30),
]
for k, ok in checks:
    if k not in d:
        errs.append(f"missing {k}")
    elif not ok(d[k]):
        errs.append(f"{k}={d[k]!r}")
try:
    md = (w / "contract-summary.md").read_text(encoding="utf-8")
    words = len(re.findall(r"[A-Za-z0-9][\w'.,%$-]*", md))
    if words > 170:  # 150 asked; a little slack for headings and list markers
        errs.append(f"summary is {words} words")
    if "2,100" not in md and "2100" not in md:
        errs.append("summary doesn't give the current fee")
except OSError as e:
    errs.append(f"contract-summary.md: {e}")
finish(not errs, "; ".join(errs) or "ok")
