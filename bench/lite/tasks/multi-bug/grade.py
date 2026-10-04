import re, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import run_unittests, snapshot, run, finish
w = pathlib.Path(sys.argv[1])
tests = "".join(p.read_text() for p in w.glob("test*.py"))
if not ("InsufficientStock" in tests and "low_stock" in tests):
    finish(False, "agent did not add tests for the two reported bugs")
s = snapshot(w)
r = run([sys.executable, "-m", "unittest"], cwd=s)
if r.returncode != 0:
    finish(False, "agent's own test suite fails: " + r.stderr[-800:])
run_unittests(w, pathlib.Path(__file__).parent / "hidden", ["test_hidden_inv.py"])
