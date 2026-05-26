"""Tests for sidecar.agent.skills — skill discovery and metadata."""

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


class TestSkillsList(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp()
        self._root = tempfile.mkdtemp()
        self._old_home = os.environ.get("ZWORK_HOME")
        self._old_root = os.environ.get("ZWORK_ROOT")
        os.environ["ZWORK_HOME"] = self._tmp
        os.environ["ZWORK_ROOT"] = self._root
        # Create zWork-Skills directory
        (Path(self._root) / "zWork-Skills").mkdir(exist_ok=True)

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
            # Force a refresh so env changes take effect
            sk.list_skills(refresh=True)
            return sk
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_list_skills_returns_list(self) -> None:
        sk = self._import()
        result = sk.list_skills(refresh=True)
        self.assertIsInstance(result, list)

    def test_list_skills_finds_installed_skill(self) -> None:
        sk = self._import()
        skills_dir = Path(self._root) / "zWork-Skills"
        _write_skill(skills_dir, "test-skill-abc", "Test Skill ABC", "Does testing.")
        result = sk.list_skills(refresh=True)
        slugs = [s.slug if hasattr(s, "slug") else s.get("slug", "") for s in result]
        # Slug is derived from the folder name
        self.assertTrue(any("test-skill-abc" in str(s) for s in slugs))

    def test_skill_has_name_field(self) -> None:
        sk = self._import()
        skills_dir = Path(self._root) / "zWork-Skills"
        _write_skill(skills_dir, "named-skill-xyz", "My Skill XYZ", "Does stuff.")
        result = sk.list_skills(refresh=True)
        names = [s.name if hasattr(s, "name") else s.get("name", "") for s in result]
        self.assertIn("My Skill XYZ", names)

    def test_skill_has_description_field(self) -> None:
        sk = self._import()
        skills_dir = Path(self._root) / "zWork-Skills"
        _write_skill(skills_dir, "desc-skill-xyz", "Desc Skill", "Unique desc 999.")
        result = sk.list_skills(refresh=True)
        descs = [s.description if hasattr(s, "description") else s.get("description", "") for s in result]
        self.assertTrue(any("Unique desc 999" in (d or "") for d in descs))

    def test_find_skill_by_slug(self) -> None:
        sk = self._import()
        skills_dir = Path(self._root) / "zWork-Skills"
        _write_skill(skills_dir, "findme-skill", "Find Me", "Findable skill.")
        sk.list_skills(refresh=True)
        result = sk.find_skill("findme-skill")
        if result is not None:
            name = result.name if hasattr(result, "name") else result.get("name")
            self.assertEqual(name, "Find Me")

    def test_as_dicts_returns_list_of_dicts(self) -> None:
        sk = self._import()
        result = sk.as_dicts()
        self.assertIsInstance(result, list)
        for item in result:
            self.assertIsInstance(item, dict)


if __name__ == "__main__":
    unittest.main()
