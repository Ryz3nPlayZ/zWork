import pathlib, subprocess, sys, tempfile, unittest

def run(*args):
    return subprocess.run([sys.executable, "wordfreq.py", *args], capture_output=True, text=True, timeout=30)

class TestHidden(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())
        (self.d / "a.txt").write_text("b a B c A a d-d e2e Don't don't\nzeta Zeta ZETA beta")
        (self.d / "stop.txt").write_text("a\n\nzeta\n")

    def test_default(self):
        r = run(str(self.d / "a.txt"))
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        self.assertEqual(lines, ["a 3", "zeta 3", "b 2", "d 2", "don 2", "e 2", "t 2", "beta 1", "c 1"])

    def test_n_and_minlen(self):
        r = run(str(self.d / "a.txt"), "-n", "2", "--min-length", "3")
        self.assertEqual(r.stdout.split(), ["zeta", "3", "don", "2"])

    def test_stopwords(self):
        r = run(str(self.d / "a.txt"), "--stopwords", str(self.d / "stop.txt"), "-n", "3")
        self.assertEqual([l for l in r.stdout.splitlines() if l], ["b 2", "d 2", "don 2"])

    def test_missing(self):
        r = run(str(self.d / "nope.txt"))
        self.assertEqual(r.returncode, 2)
        self.assertTrue(r.stderr.strip())
        self.assertEqual(r.stdout.strip(), "")
