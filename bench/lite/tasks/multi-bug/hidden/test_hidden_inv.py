import unittest
from inventory import Inventory, InsufficientStock


class TestHidden(unittest.TestCase):
    def test_total(self):
        inv = Inventory(); inv.add("a", 3); inv.add("b", 4); inv.remove("a", 1)
        self.assertEqual(inv.total_units(), 6)

    def test_insufficient(self):
        inv = Inventory(); inv.add("a", 2)
        with self.assertRaises(InsufficientStock):
            inv.remove("a", 3)
        self.assertEqual(inv.count("a"), 2)
        with self.assertRaises(InsufficientStock):
            inv.remove("zzz", 1)
        inv.remove("a", 2)
        self.assertEqual(inv.count("a"), 0)

    def test_low_stock(self):
        inv = Inventory()
        for sku, q in [("m", 5), ("c", 1), ("x", 9), ("b", 4)]:
            inv.add(sku, q)
        self.assertEqual(inv.low_stock(), ["b", "c", "m"])
        self.assertEqual(inv.low_stock(threshold=1), ["c"])
