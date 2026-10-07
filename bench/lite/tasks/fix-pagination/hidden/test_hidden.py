import unittest
from pager import paginate, page_count


class TestHidden(unittest.TestCase):
    def test_pages_cover_everything_once(self):
        for total in (0, 1, 9, 10, 11, 25, 30, 99):
            for per in (1, 3, 10):
                items = list(range(total))
                out = []
                for p in range(1, page_count(total, per) + 1):
                    out += paginate(items, p, per)
                self.assertEqual(out, items, (total, per))

    def test_page_count(self):
        self.assertEqual(page_count(0, 10), 0)
        self.assertEqual(page_count(10, 10), 1)
        self.assertEqual(page_count(11, 10), 2)
        with self.assertRaises(ValueError):
            page_count(5, 0)

    def test_first_and_past_end(self):
        items = list(range(25))
        self.assertEqual(paginate(items, 1, 10), list(range(10)))
        self.assertEqual(paginate(items, 3, 10), [20, 21, 22, 23, 24])
        self.assertEqual(paginate(items, 4, 10), [])
        with self.assertRaises(ValueError):
            paginate(items, 0)


if __name__ == "__main__":
    unittest.main()
