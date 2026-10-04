import csv, json, sys, pathlib
from collections import defaultdict
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import finish

src = pathlib.Path(__file__).parent / "repo" / "sales.csv"
rev = defaultdict(float); qty = defaultdict(int); refunded = set(); total = 0.0
for r in csv.DictReader(open(src)):
    if r["status"] == "refunded":
        refunded.add(r["order_id"]); continue
    v = int(r["quantity"]) * float(r["unit_price"])
    total += v; rev[r["region"].strip().title()] += v; qty[r["product"]] += int(r["quantity"])
want = {"total_revenue": round(total, 2), "revenue_by_region": {k: round(v, 2) for k, v in rev.items()},
        "top_product": max(qty, key=qty.get), "refunded_orders": len(refunded)}
try:
    got = json.load(open(pathlib.Path(sys.argv[1]) / "report.json"))
except Exception as e:
    finish(False, f"report.json unreadable: {e}")
errs = []
if abs(got.get("total_revenue", -1) - want["total_revenue"]) > 0.011: errs.append(f"total_revenue {got.get('total_revenue')} != {want['total_revenue']}")
gr = got.get("revenue_by_region", {})
if set(gr) != set(want["revenue_by_region"]): errs.append(f"regions {sorted(gr)} != {sorted(want['revenue_by_region'])}")
else:
    for k, v in want["revenue_by_region"].items():
        if abs(gr[k] - v) > 0.011: errs.append(f"region {k} {gr[k]} != {v}")
if got.get("top_product") != want["top_product"]: errs.append(f"top_product {got.get('top_product')} != {want['top_product']}")
if got.get("refunded_orders") != want["refunded_orders"]: errs.append(f"refunded_orders {got.get('refunded_orders')} != {want['refunded_orders']}")
finish(not errs, "; ".join(errs) or "ok")
