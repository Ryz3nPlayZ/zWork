`inventory.py` has a failing test (`python3 -m unittest`). Fix it. While you're in there, two other bugs were reported by users that the tests don't cover yet:

1. Removing more stock than is available should raise `InsufficientStock`, but it silently goes negative.
2. `low_stock()` is supposed to include items AT the threshold, not just below it, and should return SKUs sorted alphabetically.

Fix all three, and add tests for the two reported bugs.
