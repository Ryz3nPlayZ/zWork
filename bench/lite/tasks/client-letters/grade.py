import csv, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import finish

w = pathlib.Path(sys.argv[1])
tpl = """{greeting}

Thank you for being one of our customers in {city} this year. As a small thank-you, {company} gets 15% off its next order with the code SPRING26.

Warm regards,
Dana Whitfield
Whitfield Office Supply
"""
people = [
    ("Maria_Gonzalez.md", "maria@gonzalezdental.example", "Dear Dr. Gonzalez,", "Austin", "Gonzalez Dental"),
    ("James_O'Brien.md", "james@obrienplumbing.example", "Dear James,", "Denver", "O'Brien Plumbing"),
    ("Sarah_Lee.md", "sarah.lee@university.example", "Dear Prof. Lee,", "Boston", "Lee Lab"),
    ("Tom_Becker.md", "tom@beckerbikes.example", "Dear Tom,", "Portland", "Becker Bikes"),
    ("Raj_Patel.md", "raj@patelimports.example", "Dear Raj,", "Austin", "Patel Imports"),
]
d = w / "letters"
errs = []
got = sorted(p.name for p in d.glob("*.md")) if d.is_dir() else []


def same_name(a, b):
    # The prompt doesn't say what to do with an apostrophe in a name, so
    # James_O'Brien.md and James_OBrien.md both count.
    return a.replace("'", "").replace("\u2019", "") == b.replace("'", "").replace("\u2019", "")


# Each expected letter -> the file the agent actually wrote for it.
found = {}
for want_name, *_ in people:
    match = [g for g in got if same_name(g, want_name)]
    if len(match) == 1:
        found[want_name] = match[0]
if len(found) != len(people) or len(got) != len(people):
    errs.append(f"letters {got} != {sorted(p[0] for p in people)}")


def lines(t):
    return [l.rstrip() for l in t.strip().splitlines()]


for name, _, greeting, city, company in people:
    p = d / found.get(name, name)
    if p.exists():
        want = tpl.format(greeting=greeting, city=city, company=company)
        if lines(p.read_text(encoding="utf-8")) != lines(want):
            errs.append(f"{name} text differs: {p.read_text(encoding='utf-8')[:160]!r}")
try:
    with open(d / "sent.csv", newline="", encoding="utf-8-sig") as f:
        rows = [[c.strip() for c in r] for r in csv.reader(f) if any(c.strip() for c in r)]
    if rows[0] != ["email", "file"]:
        errs.append(f"sent.csv header {rows[0]}")
    body = [(r[0], r[1].split("/")[-1]) for r in rows[1:]]
    want = sorted((p[1], found.get(p[0], p[0])) for p in people)
    if body != want:
        errs.append(f"sent.csv {body} != {want}")
except (OSError, IndexError) as e:
    errs.append(f"sent.csv: {e}")
finish(not errs, "; ".join(errs) or "ok")
