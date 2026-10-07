import unittest
from inventory import Inventory


class TestInventory(unittest.TestCase):
    def test_total_units(self):
        inv = Inventory()
        inv.add("a", 3); inv.add("b", 4)
        self.assertEqual(inv.total_units(), 7)


if __name__ == "__main__":
    unittest.main()
