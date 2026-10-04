"""Roman numeral conversion."""


def to_roman(n):
    """Convert an int in 1..3999 to a canonical Roman numeral string (e.g. 1994 -> 'MCMXCIV').

    Raises ValueError for ints outside 1..3999 and TypeError for non-int input
    (bool counts as non-int).
    """
    raise NotImplementedError


def from_roman(s):
    """Parse a canonical uppercase Roman numeral (1..3999) back to an int.

    Raises ValueError for anything that is not the canonical form produced by
    `to_roman` — e.g. '', 'IIII', 'IC', 'VX', 'MMMM', lowercase 'xii'.
    """
    raise NotImplementedError
