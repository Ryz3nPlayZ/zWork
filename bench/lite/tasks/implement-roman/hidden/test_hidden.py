import unittest
from roman import to_roman, from_roman


class TestRoman(unittest.TestCase):
    def test_known(self):
        for n, s in [(1, "I"), (4, "IV"), (9, "IX"), (14, "XIV"), (40, "XL"), (90, "XC"),
                     (400, "CD"), (944, "CMXLIV"), (1994, "MCMXCIV"), (2024, "MMXXIV"), (3999, "MMMCMXCIX")]:
            self.assertEqual(to_roman(n), s)
            self.assertEqual(from_roman(s), n)

    def test_roundtrip(self):
        for n in range(1, 4000):
            self.assertEqual(from_roman(to_roman(n)), n)

    def test_to_roman_invalid(self):
        for bad in (0, -1, 4000):
            with self.assertRaises(ValueError):
                to_roman(bad)
        for bad in (1.0, "5", None, True):
            with self.assertRaises(TypeError):
                to_roman(bad)

    def test_from_roman_invalid(self):
        for bad in ("", "IIII", "IC", "VX", "MMMM", "xii", "IIV", "LL", "DM", "ABC", "XM"):
            with self.assertRaises(ValueError, msg=bad):
                from_roman(bad)


if __name__ == "__main__":
    unittest.main()
