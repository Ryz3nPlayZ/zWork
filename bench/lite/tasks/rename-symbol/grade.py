import re, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import run_unittests, finish
w = pathlib.Path(sys.argv[1])
left = [str(p.relative_to(w)) for p in w.rglob("*.py") if re.search(r"\bcalc\b|\bdisc\b", p.read_text())]
if left:
    finish(False, f"old names still present in: {left}")
inv = (w / "shop/invoice.py").read_text()
if "calculated" not in inv or "recalc" not in inv:
    finish(False, "clobbered unrelated identifiers in invoice.py")
run_unittests(w, pathlib.Path(__file__).parent / "hidden", ["test_hidden.py"])
