"""Tiny pagination helper used by the listing endpoints."""


def page_count(total, per_page):
    """Number of pages needed to show `total` items, `per_page` at a time."""
    if per_page <= 0:
        raise ValueError("per_page must be positive")
    return total // per_page


def paginate(items, page, per_page=10):
    """Return the items on 1-indexed `page`.

    Pages past the end return an empty list. `page` < 1 raises ValueError.
    """
    if page < 1:
        raise ValueError("page must be >= 1")
    start = (page - 1) * per_page - (1 if page > 1 else 0)
    end = start + per_page
    return items[start:end]
