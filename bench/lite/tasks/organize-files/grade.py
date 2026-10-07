import csv, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from _grade import finish
inbox = pathlib.Path(sys.argv[1]) / "inbox"
want = {
    "README": "other/README", "Photo.PNG": "images/Photo.PNG", "archive.tar.gz": "other/archive.tar.gz",
    "data.csv": "other/data.csv", "logo.gif": "images/logo.gif", "notes.txt": "docs/notes.txt",
    "old/deep/notes.TXT": "docs/notes.TXT", "old/notes.txt": "docs/notes-1.txt", "old/report.pdf": "docs/report.pdf",
    "old/scan.jpeg": "images/scan.jpeg", "report.pdf": "docs/report-1.pdf", "song.mp3": "other/song.mp3",
}
# Case-insensitive filesystems (macOS) can legitimately collide notes.TXT with notes.txt; accept either suffixing.
alt = dict(want); alt["old/deep/notes.TXT"] = "docs/notes-1.TXT"; alt["old/notes.txt"] = "docs/notes-2.txt"
errs = []
actual = sorted(str(p.relative_to(inbox)) for p in inbox.rglob("*") if p.is_file() and p.name != "manifest.csv")
best = None
for w in (want, alt):
    e = []
    if sorted(w.values()) != actual: e.append(f"files {actual} != {sorted(w.values())}")
    for orig, new in w.items():
        p = inbox / new
        if p.exists() and p.read_text() != f"content of {orig}\n": e.append(f"{new} has wrong content")
    try:
        rows = list(csv.reader(open(inbox / "manifest.csv")))
        if rows[0] != ["original", "new"]: e.append(f"bad header {rows[0]}")
        body = rows[1:]
        if sorted(body) != sorted([[k, v] for k, v in w.items()]): e.append(f"manifest rows {body} != {sorted([[k, v] for k, v in w.items()])}")
        elif body != sorted(body) and body != sorted(body, key=lambda r: r[0].lower()): e.append("manifest not sorted by original")
    except Exception as ex:
        e.append(f"manifest: {ex}")
    if [d for d in inbox.iterdir() if d.is_dir() and d.name not in ("images", "docs", "other")]: e.append("leftover subfolders")
    if best is None or len(e) < len(best): best = e
finish(not best, "; ".join(best) or "ok")
