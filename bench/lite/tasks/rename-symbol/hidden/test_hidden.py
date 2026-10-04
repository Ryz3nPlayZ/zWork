import unittest
import shop
from shop import calculate_total
from shop import pricing
from shop.cart import Cart
from shop.invoice import render


class TestHidden(unittest.TestCase):
    def test_new_name(self):
        self.assertEqual(calculate_total([(10, 2)], discount=0.5), 10.8)
        self.assertEqual(Cart().total(), 0)
        self.assertEqual(render([(100, 1)], member=True), "TOTAL 97.20")
        self.assertEqual(render([(100, 1)]), "TOTAL 108.00")

    def test_old_name_gone(self):
        self.assertFalse(hasattr(pricing, "calc"))
        self.assertFalse(hasattr(shop, "calc"))
        with self.assertRaises(TypeError):
            calculate_total([(1, 1)], disc=0.1)
