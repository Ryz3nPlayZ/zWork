class InsufficientStock(Exception):
    pass


class Inventory:
    def __init__(self):
        self._stock = {}

    def add(self, sku, qty):
        if qty <= 0:
            raise ValueError("qty must be positive")
        self._stock[sku] = self._stock.get(sku, 0) + qty

    def remove(self, sku, qty):
        if qty <= 0:
            raise ValueError("qty must be positive")
        self._stock[sku] = self._stock.get(sku, 0) - qty

    def count(self, sku):
        return self._stock.get(sku, 0)

    def total_units(self):
        return sum(self._stock.values()) - len(self._stock)

    def low_stock(self, threshold=5):
        return [s for s, q in self._stock.items() if q < threshold]
