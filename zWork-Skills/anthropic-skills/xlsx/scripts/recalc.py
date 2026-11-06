#!/usr/bin/env python3
"""Check a workbook before it is handed over: calculate every formula and list
what would show an error in Excel, plus layout problems a reader would trip on.

    python recalc.py report.xlsx

Prints JSON. The file is never changed. Excel calculates formulas itself on
open, so this only needs to find the mistakes.

shortcut: uses the `formulas` package, which lacks some newer Excel functions;
those land in `unchecked`, not `errors`. Add LibreOffice if that list gets long.
"""
import json
import os
import sys
from collections import defaultdict

import openpyxl

ERROR_VALUES = {"#REF!", "#DIV/0!", "#VALUE!", "#N/A", "#NAME?", "#NUM!", "#NULL!"}


def report(errors, total_formulas, unchecked, warnings):
    summary = {k: {"count": len(v), "locations": v[:20]} for k, v in errors.items()}
    out = {
        "status": "errors_found" if errors else "success",
        "total_errors": sum(len(v) for v in errors.values()),
        "total_formulas": total_formulas,
        "unchecked_formulas": unchecked[:20],
        "layout_warnings": warnings,
    }
    if summary:
        out["error_summary"] = summary
    return out


def formula_cells(book):
    """{"SHEET!A1": formula} for every formula, the keys upper-cased to match `formulas`."""
    found = {}
    for sheet in book.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if cell.data_type == "f":
                    found[f"{sheet.title.upper()}!{cell.coordinate}"] = cell.value
    return found


def calculate(path):
    """{"SHEET!A1": value} for every cell the formula engine worked out."""
    import formulas  # slow import, and not needed for a workbook with no formulas

    solution = formulas.ExcelModel().loads(path).finish().calculate()
    values = {}
    for ref, ranges in solution.items():
        if not isinstance(ref, str) or "!" not in ref or ":" in ref.split("!")[1]:
            continue
        value = getattr(ranges, "value", None)
        if value is None:
            continue
        cell = ref.split("]")[-1].replace("'", "").upper()
        values[cell] = value.ravel()[0]
    return values


def layout_warnings(book):
    warnings = []
    for sheet in book.worksheets:
        if sheet.max_row > 30 and sheet.max_column > 1 and not sheet.freeze_panes:
            warnings.append(f"{sheet.title}: long table with no frozen header row")
        for column in sheet.iter_cols(max_row=min(sheet.max_row, 200)):
            letter = column[0].column_letter
            width = sheet.column_dimensions[letter].width or 8.43
            longest = max((len(str(c.value)) for c in column if isinstance(c.value, str) and c.data_type != "f"), default=0)
            if longest > width * 2:
                warnings.append(f"{sheet.title}: column {letter} is too narrow for its text")
    return warnings


def check(path):
    book = openpyxl.load_workbook(path)
    cells = formula_cells(book)
    errors, unchecked = defaultdict(list), []
    # A saved #REF! typed into a formula never needs calculating to be wrong.
    for where, formula in cells.items():
        if "#REF!" in str(formula):
            errors["#REF!"].append(where)
    if cells:
        values = calculate(path)
        for where in cells:
            value = values.get(where)
            text = str(value)
            if value is None:
                unchecked.append(where)
            elif text in ERROR_VALUES and where not in errors["#REF!"]:
                errors[text].append(where)
    # Errors stored as plain values, e.g. pasted in from another workbook.
    for sheet in book.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if cell.data_type == "e" or cell.value in ERROR_VALUES:
                    errors[str(cell.value)].append(f"{sheet.title}!{cell.coordinate}")
    return report({k: v for k, v in errors.items() if v}, len(cells), unchecked, layout_warnings(book))


if __name__ == "__main__":
    if len(sys.argv) < 2 or not os.path.isfile(sys.argv[1]):
        sys.exit("usage: recalc.py <file.xlsx>")
    print(json.dumps(check(sys.argv[1]), indent=2))
