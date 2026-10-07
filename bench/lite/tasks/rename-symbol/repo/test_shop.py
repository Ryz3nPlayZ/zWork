import unittest
from shop import calc
from shop.cart import Cart
from shop.invoice import render


class TestShop(unittest.TestCase):
    def test_calc(self):
        self.assertEqual(calc([(10, 2)], disc=0.5), 10.8)

    def test_cart(self):
        c = Cart(); c.add(5, 3)
        self.assertEqual(c.total(), 16.2)

    def test_invoice(self):
        self.assertEqual(render([(100, 1)], member=True), "TOTAL 97.20")


if __name__ == "__main__":
    unittest.main()
