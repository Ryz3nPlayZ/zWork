from .pricing import calc


class Cart:
    def __init__(self):
        self.lines = []

    def add(self, price, qty=1):
        self.lines.append((price, qty))

    def total(self, disc=0.0):
        return calc(self.lines, disc=disc)
