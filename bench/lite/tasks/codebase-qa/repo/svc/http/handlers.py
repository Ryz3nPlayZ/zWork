from ..maintenance import retention


def health(req, ctx):
    return 200, "ok"


def compact(req, ctx):
    ctx.store.compact()
    return 204, ""


def cleanup_events(req, ctx):
    days = int(req.query.get("days", 30))
    retention.apply(ctx.store, days)
    return 204, ""


def purge_cache(req, ctx):
    # Despite the name this only clears the in-memory cache, not the store.
    ctx.cache.clear()
    return 204, ""
