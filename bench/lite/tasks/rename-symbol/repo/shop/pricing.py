TAX = 0.08


def calc(items, disc=0.0):
    """Total of (price, qty) pairs, minus a fractional discount, plus tax."""
    subtotal = sum(p * q for p, q in items)
    return round(subtotal * (1 - disc) * (1 + TAX), 2)
