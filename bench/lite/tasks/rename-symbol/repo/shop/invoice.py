from . import pricing


def render(lines, member=False):
    # Members get 10% off. Note: `calculated` and `recalc` below are unrelated names.
    calculated = pricing.calc(lines, disc=0.1 if member else 0.0)
    recalc = False
    return f"TOTAL {calculated:.2f}" + (" (recalc)" if recalc else "")
