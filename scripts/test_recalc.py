#!/usr/bin/env python3
"""Self-check for the spreadsheet checker. Needs openpyxl and formulas.

    python3 scripts/test_recalc.py
"""
import importlib.util
import pathlib
import tempfile

import openpyxl

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("recalc", ROOT / "zWork-Skills/anthropic-skills/xlsx/scripts/recalc.py")
recalc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recalc)

with tempfile.TemporaryDirectory() as tmp:
    good, bad = f"{tmp}/good.xlsx", f"{tmp}/bad.xlsx"

    book = openpyxl.Workbook()
    book.active.append(["Item", "Amount"])
    book.active.append(["Rent", 1000])
    book.active.append(["Total", "=SUM(B2:B2)"])
    book.save(good)
    result = recalc.check(good)
    assert result["status"] == "success" and result["total_formulas"] == 1, result

    book = openpyxl.Workbook()
    sheet = book.active
    sheet["A1"], sheet["A2"] = 5, 0
    sheet["B1"] = "=A1/A2"
    sheet["B2"] = "=NOSUCHFN(1)"
    sheet["B3"] = "=#REF!+1"
    book.save(bad)
    result = recalc.check(bad)
    assert result["status"] == "errors_found", result
    assert set(result["error_summary"]) == {"#DIV/0!", "#NAME?", "#REF!"}, result

print("ok")
