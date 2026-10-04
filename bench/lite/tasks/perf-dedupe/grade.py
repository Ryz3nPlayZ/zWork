import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import run_unittests
run_unittests(sys.argv[1], pathlib.Path(__file__).parent / "hidden", ["test_hidden.py"], timeout=60)
