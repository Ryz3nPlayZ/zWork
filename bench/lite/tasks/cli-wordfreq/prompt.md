Write a small CLI `wordfreq.py` (Python 3, stdlib only) that prints the most frequent words in a text file.

Usage: `python3 wordfreq.py FILE [-n N] [--min-length L] [--stopwords STOPFILE]`

- Words are runs of letters a-z (case-insensitive; apostrophes split words; digits are not words). Lowercase everything.
- `-n` defaults to 10. `--min-length` (default 1) drops shorter words. `--stopwords` is a file with one word per line to ignore.
- Output one line per word: `<word> <count>`, sorted by count descending, ties broken alphabetically.
- If FILE doesn't exist, print an error to stderr and exit with status 2.

There's a `sample.txt` you can try it on.
