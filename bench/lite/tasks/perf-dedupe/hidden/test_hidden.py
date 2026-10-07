import copy, random, time, unittest
from dedupe import dedupe_records


def slow(records):
    out = []
    for rec in records:
        found = None
        for existing in out:
            if existing["email"].strip().lower() == rec["email"].strip().lower():
                found = existing; break
        if found is None:
            out.append(dict(rec))
        else:
            for k, v in rec.items():
                if v not in ("", None) and k != "email":
                    found[k] = v
    return out


def gen(n, users, seed):
    r = random.Random(seed)
    recs = []
    for i in range(n):
        u = r.randrange(users)
        e = f"user{u}@x.com"
        e = r.choice([e, e.upper(), " " + e, e + "  "])
        recs.append({"email": e, "name": r.choice(["", None, f"n{i}"]), "plan": r.choice(["", "pro", "free"])})
    return recs


class TestHidden(unittest.TestCase):
    def test_equivalent(self):
        for seed in range(5):
            recs = gen(800, 150, seed)
            before = copy.deepcopy(recs)
            self.assertEqual(dedupe_records(recs), slow(recs))
            self.assertEqual(recs, before, "input mutated")

    def test_fast(self):
        recs = gen(200_000, 50_000, 99)
        t = time.perf_counter()
        out = dedupe_records(recs)
        dt = time.perf_counter() - t
        self.assertLess(dt, 1.5, f"took {dt:.2f}s")
        self.assertLessEqual(len(out), 50_000)
