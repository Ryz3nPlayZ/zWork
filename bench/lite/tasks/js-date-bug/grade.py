import shutil, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import snapshot, run, finish
w = snapshot(sys.argv[1])
shutil.copy(pathlib.Path(__file__).parent / "hidden/test_hidden.js", w / "test_hidden.js")
r = run(["node", "test_hidden.js"], cwd=w, timeout=60)
finish(r.returncode == 0, (r.stdout + r.stderr).strip())
