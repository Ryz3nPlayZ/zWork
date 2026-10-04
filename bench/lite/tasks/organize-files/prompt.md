The `inbox/` folder is a mess. Organize it:

- Move images (.png .jpg .jpeg .gif, any case) into `inbox/images/`, documents (.pdf .docx .txt .md) into `inbox/docs/`, and everything else into `inbox/other/`.
- Files whose names start with `tmp_` or end with `~` are junk — delete them instead.
- If two files would end up with the same name in a folder, keep both by appending `-1`, `-2`… before the extension to the later ones (in alphabetical order of their original paths).
- Files in subfolders of inbox (like `inbox/old/`) should be pulled up and organized too; remove the now-empty subfolders.
- Write `inbox/manifest.csv` with header `original,new` listing every moved file (paths relative to `inbox/`), sorted by `original`. Don't list deleted files.
