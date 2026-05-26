"""Tests for sidecar.agent.skills — skill discovery and metadata parsing."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path


def _write_skill(skills_dir: Path, skill_id: str, name: str, description: str) -> None:
    skill_path = skills_dir / skill_id
    skill_path.mkdir(parents=True, exist_ok=True)
    skill_md = f"---\nname: {name}\ndescription: {description}\n---\n\n# Instructions\n\nDo things.\n"
    (skill_path / "SKILL.md").write_text(skill_md, encoding="utf-8")


class TestSkillsIndexing(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp()
        self._skills_tmp = tempfile.mkdtemp()
        self._old_home = os.environ.get("ZWORK_HOME")
        self._old_root = os.environ.get("ZWORK_ROOT")
        os.environ["ZWORK_HOME"] = self._tmp
        os.environ["ZWORK_ROOT"] = self._skills_tmp
        # Create zWork-Skills directory under root
        (Path(self._skills_tmp) / "zWork-Skills").mkdir(exist_ok=True)

    def tearDown(self) -> None:
        if self._old_home is None:
            os.environ.pop("ZWORK_HOME", None)
        else:
            os.environ["ZWORK_HOME"] = self._old_home
        if self._old_root is None:
            os.environ.pop("ZWORK_ROOT", None)
        else:
            os.environ["ZWORK_ROOT"] = self._old_root

    def _import(self):
        try:
            import sidecar.agent.skills as sk
            return sk
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_index_skills_returns_list(self) -> None:
        sk = self._import()
        result = sk.index_skills()
        self.assertIsInstance(result, list)

    def test_index_skills_finds_installed_skill(self) -> None:
        sk = self._import()
        skills_dir = Path(self._skills_tmp) / "zWork-Skills"
        _write_skill(skills_dir, "test-skill-abc", "Test Skill", "Does testing.")
        # Re-index
        result = sk.index_skills()
        ids = [s.id if hasattr(s, "id") else s.get("id") for s in result]
        self.assertIn("test-skill-abc", ids)

    def test_skill_metadata_has_name(self) -> None:
        sk = self._import()
        skills_dir = Path(self._skills_tmp) / "zWork-Skills"
        _write_skill(skills_dir, "named-skill", "My Named Skill", "Does stuff.")
        result = sk.index_skills()
        names = [s.name if hasattr(s, "name") else s.get("name") for s in result]
        self.assertIn("My Named Skill", names)

    def test_skill_metadata_has_description(self) -> None:
        sk = self._import()
        skills_dir = Path(self._skills_tmp) / "zWork-Skills"
        _write_skill(skills_dir, "desc-skill", "Desc Skill", "Unique description XYZ.")
        result = sk.index_skills()
        descs = [s.description if hasattr(s, "description") else s.get("description") for s in result]
        self.assertTrue(any("Unique description XYZ" in (d or "") for d in descs))

    def test_index_empty_skills_dir(self) -> None:
        sk = self._import()
        # No skills installed; should return empty list without error
        result = sk.index_skills()
        self.assertIsInstance(result, list)


if __name__ == "__main__":
    unittest.main()
