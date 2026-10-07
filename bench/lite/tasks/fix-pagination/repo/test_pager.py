import unittest
from pager import paginate, page_count


class TestPager(unittest.TestCase):
    def test_second_page(self):
        items = list(range(25))
        self.assertEqual(paginate(items, 2, 10), list(range(10, 20)))

    def test_page_count_partial(self):
        self.assertEqual(page_count(25, 10), 3)


if __name__ == "__main__":
    unittest.main()
