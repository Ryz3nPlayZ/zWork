import json, sqlite3, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import finish
w = pathlib.Path(sys.argv[1])
db = sqlite3.connect(f"file:{w / 'shop.db'}?mode=ro", uri=True)
rows = db.execute("""
 SELECT c.email, SUM(o.total_cents) - COALESCE(SUM(r.ref),0) FROM orders o JOIN customers c ON c.id=o.customer_id
 LEFT JOIN (SELECT order_id, SUM(amount_cents) ref FROM refunds GROUP BY order_id) r ON r.order_id=o.id
 WHERE o.placed_at >= '2025-01-01' AND o.placed_at < '2026-01-01' AND o.status != 'cancelled'
 GROUP BY c.id ORDER BY 2 DESC""").fetchall()
email, cents = rows[0]
try:
    a = json.load(open(w / "answer.json"))
except Exception as e:
    finish(False, f"answer.json unreadable: {e}")
ok = a.get("email") == email and abs(float(a.get("net_spend", -1)) - cents / 100) < 0.006
finish(ok, f"got {a} want email={email} net_spend={cents/100:.2f}")
