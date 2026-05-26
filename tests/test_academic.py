"""Tests for academic research tools — check_novelty result structure and paper review."""

from __future__ import annotations

import unittest


class TestCheckNoveltyResultStructure(unittest.TestCase):
    """Validate the structure of results returned by the novelty-check helpers."""

    def _import(self):
        try:
            import sidecar.agent.academic as ac
            return ac
        except ImportError:
            self.skipTest("sidecar.agent.academic not available")

    def test_format_results_returns_string(self) -> None:
        ac = self._import()
        if not hasattr(ac, "format_results"):
            self.skipTest("format_results not implemented")
        sample = [
            {
                "title": "Attention is All You Need",
                "authors": ["Vaswani et al."],
                "year": 2017,
                "abstract": "We propose a new architecture...",
                "url": "https://arxiv.org/abs/1706.03762",
            }
        ]
        result = ac.format_results(sample)
        self.assertIsInstance(result, str)
        self.assertIn("Attention is All You Need", result)

    def test_estimate_word_count_zero_for_empty(self) -> None:
        ac = self._import()
        if not hasattr(ac, "estimate_word_count"):
            self.skipTest("estimate_word_count not implemented")
        self.assertEqual(ac.estimate_word_count(""), 0)

    def test_estimate_word_count_accurate(self) -> None:
        ac = self._import()
        if not hasattr(ac, "estimate_word_count"):
            self.skipTest("estimate_word_count not implemented")
        text = "one two three four five"
        self.assertEqual(ac.estimate_word_count(text), 5)

    def test_check_section_coverage_detects_missing(self) -> None:
        ac = self._import()
        if not hasattr(ac, "check_section_coverage"):
            self.skipTest("check_section_coverage not implemented")
        paper = "# Abstract\n\nSome text.\n\n# Introduction\n\nMore text."
        missing = ac.check_section_coverage(paper)
        self.assertIsInstance(missing, list)
        # A minimal paper is missing many standard sections
        self.assertGreater(len(missing), 0)

    def test_check_section_coverage_full_paper(self) -> None:
        ac = self._import()
        if not hasattr(ac, "check_section_coverage"):
            self.skipTest("check_section_coverage not implemented")
        paper = (
            "# Abstract\n\n# Introduction\n\n# Related Work\n\n"
            "# Methodology\n\n# Results\n\n# Conclusion\n\n"
        )
        missing = ac.check_section_coverage(paper)
        self.assertIsInstance(missing, list)
        self.assertEqual(len(missing), 0)

    def test_count_references_zero_for_empty(self) -> None:
        ac = self._import()
        if not hasattr(ac, "count_references"):
            self.skipTest("count_references not implemented")
        self.assertEqual(ac.count_references(""), 0)

    def test_count_references_detects_entries(self) -> None:
        ac = self._import()
        if not hasattr(ac, "count_references"):
            self.skipTest("count_references not implemented")
        paper = "# References\n\n[1] Author A. Title. 2020.\n[2] Author B. Title. 2021.\n"
        count = ac.count_references(paper)
        self.assertGreaterEqual(count, 2)

    def test_format_citation_apa(self) -> None:
        ac = self._import()
        if not hasattr(ac, "format_citation"):
            self.skipTest("format_citation not implemented")
        record = {
            "title": "Deep Learning",
            "authors": ["Goodfellow", "Bengio", "Courville"],
            "year": 2016,
            "url": "https://www.deeplearningbook.org/",
        }
        citation = ac.format_citation(record, style="APA")
        self.assertIsInstance(citation, str)
        self.assertIn("2016", citation)

    def test_export_latex_contains_document(self) -> None:
        ac = self._import()
        if not hasattr(ac, "export_latex"):
            self.skipTest("export_latex not implemented")
        md = "# Abstract\n\nThis is a test.\n\n# Introduction\n\nHello.\n"
        latex = ac.export_latex(md)
        self.assertIsInstance(latex, str)
        self.assertIn("\\begin{document}", latex)

    def test_assemble_paper_joins_sections(self) -> None:
        ac = self._import()
        if not hasattr(ac, "assemble_paper"):
            self.skipTest("assemble_paper not implemented")
        sections = {
            "abstract": "This paper studies X.",
            "introduction": "We introduce...",
        }
        paper = ac.assemble_paper(sections)
        self.assertIsInstance(paper, str)
        self.assertIn("This paper studies X.", paper)
        self.assertIn("We introduce...", paper)


if __name__ == "__main__":
    unittest.main()
