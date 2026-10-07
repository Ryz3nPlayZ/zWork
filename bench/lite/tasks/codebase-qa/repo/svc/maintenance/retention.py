def apply(store, days):
    if days < 1:
        raise ValueError("days must be >= 1")
    store.purge(older_than_days=days)
