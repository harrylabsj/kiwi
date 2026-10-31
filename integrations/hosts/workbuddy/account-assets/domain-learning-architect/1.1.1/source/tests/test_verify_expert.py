"""Guards for the upload gate: verify_workbuddy_expert must catch real breakage."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from verify_workbuddy_expert import ROOT as PACKAGE, verify  # noqa: E402


class VerifyTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "domain-navigator"
        shutil.copytree(PACKAGE, self.root)
        self.manifest = self.root / ".codebuddy-plugin" / "plugin.json"
        self.agent = self.root / "agents" / "domain-navigator.md"
        self.cases = self.root / "evaluations" / "cases.json"

    def errors(self) -> list[str]:
        return verify(self.root)[0]

    def warnings(self) -> list[str]:
        return verify(self.root)[1]

    def patch_manifest(self, **changes) -> None:
        data = json.loads(self.manifest.read_text(encoding="utf-8"))
        for key, value in changes.items():
            if value is None:
                data.pop(key, None)
            else:
                data[key] = value
        self.manifest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def assertFlags(self, fragment: str) -> None:
        errors = self.errors()
        self.assertTrue(any(fragment in e for e in errors), f"{fragment!r} not flagged; got {errors}")

    # --- the shipped package must stay clean ---

    def test_shipped_package_is_valid(self) -> None:
        self.assertEqual(self.errors(), [])

    def test_shipped_package_has_eighteen_cases(self) -> None:
        cases = json.loads(self.cases.read_text(encoding="utf-8"))
        self.assertEqual(len(cases), 18)
        self.assertEqual(len({c["id"] for c in cases}), 18)

    def test_agent_carries_the_designed_opening_line(self) -> None:
        self.assertIn("你想进入哪个新领域？", self.agent.read_text(encoding="utf-8"))

    # --- manifest breakage ---

    def test_missing_required_field(self) -> None:
        self.patch_manifest(profession=None)
        self.assertFlags("missing field: profession")

    def test_plugin_must_equal_name(self) -> None:
        self.patch_manifest(plugin="something-else")
        self.assertFlags("plugin must equal name")

    def test_default_prompt_must_equal_first_quick_prompt(self) -> None:
        self.patch_manifest(defaultInitPrompt={"zh": "别的", "en": "other"})
        self.assertFlags("defaultInitPrompt must equal quickPrompts[0]")

    def test_short_chinese_description_rejected(self) -> None:
        self.patch_manifest(displayDescription={"zh": "太短了", "en": "too short"})
        self.assertFlags("40-50 Chinese characters")

    def test_blank_category_is_an_error_but_a_new_one_is_only_a_warning(self) -> None:
        self.patch_manifest(categoryId="")
        self.assertFlags("categoryId must be a non-empty string")
        self.patch_manifest(categoryId="07-Education")
        self.assertEqual(self.errors(), [])
        self.assertTrue(any("07-Education" in w for w in self.warnings()))

    # --- cross-file consistency ---

    def test_agent_skill_not_declared_in_manifest(self) -> None:
        text = self.agent.read_text(encoding="utf-8")
        self.agent.write_text(text.replace("  - domain-learning", "  - ghost-skill"), encoding="utf-8")
        self.assertFlags("not declared in plugin.json skills")

    def test_agent_name_must_match_exactly_not_by_prefix(self) -> None:
        text = self.agent.read_text(encoding="utf-8")
        self.agent.write_text(text.replace("name: domain-navigator", "name: domain-navigator-v2", 1), encoding="utf-8")
        self.assertFlags("agentName must match frontmatter name exactly")

    def test_missing_skill_directory(self) -> None:
        shutil.rmtree(self.root / "skills" / "domain-learning")
        self.assertFlags("missing skill")

    def test_skill_name_must_match_its_directory(self) -> None:
        skill = self.root / "skills" / "domain-learning" / "SKILL.md"
        skill.write_text(skill.read_text(encoding="utf-8").replace("name: domain-learning", "name: other"), encoding="utf-8")
        self.assertFlags("must equal its directory name")

    # --- shipped evaluation cases ---

    def test_broken_cases_json(self) -> None:
        self.cases.write_text("{ not json", encoding="utf-8")
        self.assertFlags("cannot load evaluations/cases.json")

    def test_duplicate_case_id(self) -> None:
        case = {"id": "dup", "conversation": ["a"], "expect": "b"}
        self.cases.write_text(json.dumps([case, case]), encoding="utf-8")
        self.assertFlags("duplicate case id: dup")

    def test_case_missing_expectation(self) -> None:
        self.cases.write_text(json.dumps([{"id": "x", "conversation": ["a"]}]), encoding="utf-8")
        self.assertFlags("needs a non-empty expect")

    # --- avatar ---

    def test_non_png_avatar(self) -> None:
        (self.root / "avatars" / "domain-navigator.png").write_bytes(b"not a png")
        self.assertFlags("avatar must be PNG")

    def test_missing_avatar(self) -> None:
        (self.root / "avatars" / "domain-navigator.png").unlink()
        self.assertFlags("avatar file missing")


if __name__ == "__main__":
    unittest.main()
