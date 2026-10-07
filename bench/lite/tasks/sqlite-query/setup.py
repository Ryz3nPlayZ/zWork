"""Builds shop.db in the cwd (run before the agent starts)."""
import random, sqlite3
random.seed(11)
db = sqlite3.connect("shop.db")
db.executescript("""
CREATE TABLE customers(id INTEGER PRIMARY KEY, email TEXT, name TEXT);
CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER, placed_at TEXT, status TEXT, total_cents INTEGER);
CREATE TABLE refunds(id INTEGER PRIMARY KEY, order_id INTEGER, amount_cents INTEGER, created_at TEXT);
""")
for c in range(1, 41):
    db.execute("INSERT INTO customers VALUES(?,?,?)", (c, f"cust{c}@example.com", f"Customer {c}"))
oid = 0
for _ in range(900):
    oid += 1
    c = random.randint(1, 40)
    y = random.choice([2024, 2025, 2025, 2026])
    ts = f"{y}-{random.randint(1,12):02d}-{random.randint(1,28):02d}T{random.randint(0,23):02d}:00:00"
    st = random.choices(["paid", "shipped", "cancelled"], [6, 3, 2])[0]
    db.execute("INSERT INTO orders VALUES(?,?,?,?,?)", (oid, c, ts, st, random.randint(500, 40000)))
# Traps: a whale whose big orders are cancelled / refunded / in 2024 or on the 2026 boundary.
db.execute("INSERT INTO orders VALUES(?,?,?,?,?)", (5000, 7, "2025-06-01T10:00:00", "cancelled", 900000))
db.execute("INSERT INTO orders VALUES(?,?,?,?,?)", (5001, 7, "2024-12-31T23:00:00", "paid", 900000))
db.execute("INSERT INTO orders VALUES(?,?,?,?,?)", (5002, 7, "2026-01-01T00:00:00", "paid", 900000))
db.execute("INSERT INTO orders VALUES(?,?,?,?,?)", (5003, 13, "2025-03-03T12:00:00", "paid", 600000))
db.execute("INSERT INTO refunds VALUES(?,?,?,?)", (1, 5003, 590000, "2025-03-10"))
rid = 1
for o in random.sample(range(1, 900), 120):
    rid += 1
    db.execute("INSERT INTO refunds VALUES(?,?,?,?)", (rid, o, random.randint(100, 3000), "2025-07-01"))
db.commit()
