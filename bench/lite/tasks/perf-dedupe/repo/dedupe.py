def _norm(email):
    return email.strip().lower()


def dedupe_records(records):
    """Drop duplicate records, keeping order.

    Two records are duplicates when their emails match case-insensitively and
    ignoring surrounding whitespace. When duplicates occur, the FIRST record's
    position is kept, but its fields are updated with any non-empty fields from
    later duplicates (later wins). Records are dicts; the input is not mutated.
    """
    out = []
    for rec in records:
        found = None
        for existing in out:
            if _norm(existing["email"]) == _norm(rec["email"]):
                found = existing
                break
        if found is None:
            out.append(dict(rec))
        else:
            for k, v in rec.items():
                if v not in ("", None) and k != "email":
                    found[k] = v
    return out
