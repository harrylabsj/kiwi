#!/usr/bin/env python3
"""Validate the official WorkBuddy expert package before upload."""

from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "workbuddy" / "domain-navigator"
REQUIRED = {
    "name", "version", "description", "author", "agents", "expertType",
    "agentName", "displayName", "profession", "displayDescription",
    "avatar", "categoryId", "defaultInitPrompt", "plugin", "tags", "quickPrompts",
}
# The installed WorkBuddy client (5.5.6) ships no education category, so the expert
# rides under "industry consultant". Keep this a warning, not a hard failure, so a
# later client that adds the right category is not blocked by this validator.
PREFERRED_CATEGORY = "12-IndustryConsultant"


def frontmatter(text: str) -> str | None:
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    return text[4:end] if end != -1 else None


def scalar(front: str, key: str) -> str | None:
    match = re.search(rf"^{re.escape(key)}:[ \t]*(.+?)[ \t]*$", front, re.M)
    if not match:
        return None
    return match.group(1).strip().strip("\"'") or None


def sequence(front: str, key: str) -> list[str]:
    match = re.search(rf"^{re.escape(key)}:[ \t]*$\n((?:[ \t]+-[ \t]*.+\n?)+)", front, re.M)
    if not match:
        return []
    return [line.split("-", 1)[1].strip().strip("\"'") for line in match.group(1).splitlines() if line.strip()]


def check_cases(path: Path, errors: list[str]) -> None:
    """Evaluation cases ship inside the ZIP, so a broken file must fail the build."""
    try:
        cases = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"cannot load evaluations/cases.json: {exc}")
        return
    if not isinstance(cases, list) or not cases:
        errors.append("evaluations/cases.json must be a non-empty array")
        return
    seen: set[str] = set()
    for index, case in enumerate(cases):
        label = f"case[{index}]"
        if not isinstance(case, dict):
            errors.append(f"{label} must be an object")
            continue
        case_id = case.get("id")
        if not isinstance(case_id, str) or not case_id.strip():
            errors.append(f"{label} needs a non-empty id")
        elif case_id in seen:
            errors.append(f"duplicate case id: {case_id}")
        else:
            seen.add(case_id)
        turns = case.get("conversation")
        if not isinstance(turns, list) or not turns or any(
            not isinstance(t, str) or not t.strip() for t in turns
        ):
            errors.append(f"{label} needs a non-empty conversation of strings")
        if not isinstance(case.get("expect"), str) or not case["expect"].strip():
            errors.append(f"{label} needs a non-empty expect")


def verify(root: Path = ROOT) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    manifest = root / ".codebuddy-plugin" / "plugin.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"cannot load plugin.json: {exc}"], warnings
    for field in sorted(REQUIRED - data.keys()):
        errors.append(f"missing field: {field}")
    name = data.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z]+(?:-[a-z]+)*", name):
        errors.append("name must be lowercase words separated by hyphens")
    if data.get("plugin") != name:
        errors.append("plugin must equal name")
    if data.get("expertType") != "agent":
        errors.append("expertType must be agent")
    if not isinstance(data.get("version"), str) or not re.fullmatch(r"\d+\.\d+\.\d+", data["version"]):
        errors.append("version must be semver")
    author = data.get("author")
    if not isinstance(author, dict) or not author.get("name") or not author.get("email"):
        errors.append("author.name and author.email are required")
    for field in ("displayName", "profession", "displayDescription", "defaultInitPrompt"):
        value = data.get(field)
        if not isinstance(value, dict) or not all(isinstance(value.get(lang), str) and value[lang].strip() for lang in ("zh", "en")):
            errors.append(f"{field} must contain zh and en")
    zh = data.get("displayDescription", {}).get("zh", "")
    if isinstance(zh, str):
        count = sum("一" <= char <= "鿿" for char in zh)
        if not 40 <= count <= 50:
            errors.append(f"displayDescription.zh must have 40-50 Chinese characters, got {count}")
    category = data.get("categoryId")
    if not isinstance(category, str) or not category.strip():
        errors.append("categoryId must be a non-empty string")
    elif category != PREFERRED_CATEGORY:
        warnings.append(f"categoryId is {category}, not the verified {PREFERRED_CATEGORY}; confirm the client offers it")
    for field in ("tags", "quickPrompts"):
        values = data.get(field)
        if not isinstance(values, list) or len(values) != 3:
            errors.append(f"{field} must have exactly 3 entries")
        elif any(not isinstance(v, dict) or not v.get("zh") or not v.get("en") for v in values):
            errors.append(f"{field} entries need zh and en")
    prompts = data.get("quickPrompts")
    if isinstance(prompts, list) and prompts and prompts[0] != data.get("defaultInitPrompt"):
        errors.append("defaultInitPrompt must equal quickPrompts[0]")

    declared_skills: set[str] = set()
    skills = data.get("skills", [])
    if not isinstance(skills, list):
        errors.append("skills must be an array")
    else:
        for skill in skills:
            if not isinstance(skill, str):
                errors.append(f"skills entries must be strings: {skill!r}")
                continue
            skill_dir = root / skill.removeprefix("./")
            skill_file = skill_dir / "SKILL.md"
            if not skill_file.is_file():
                errors.append(f"missing skill: {skill}")
                continue
            declared_skills.add(skill_dir.name)
            front = frontmatter(skill_file.read_text(encoding="utf-8"))
            if front is None:
                errors.append(f"{skill}/SKILL.md needs YAML frontmatter")
            elif scalar(front, "name") != skill_dir.name:
                errors.append(f"{skill}/SKILL.md name must equal its directory name {skill_dir.name}")

    agents = data.get("agents")
    if not isinstance(agents, list) or len(agents) != 1:
        errors.append("agents must contain one agent file")
    else:
        agent_path = root / agents[0].removeprefix("./")
        if not agent_path.is_file():
            errors.append(f"missing agent: {agents[0]}")
        else:
            front = frontmatter(agent_path.read_text(encoding="utf-8"))
            if front is None:
                errors.append("agent needs YAML frontmatter")
            else:
                if scalar(front, "name") != data.get("agentName"):
                    errors.append("agentName must match frontmatter name exactly")
                for field in ("description", "displayName", "profession"):
                    if not re.search(rf"^{field}:", front, re.M):
                        errors.append(f"agent frontmatter lacks {field}:")
                for used in sequence(front, "skills"):
                    if used not in declared_skills:
                        errors.append(f"agent frontmatter uses skill {used!r} not declared in plugin.json skills")
            if agent_path.stem != data.get("agentName"):
                errors.append("agentName must match agent filename")

    cases = root / "evaluations" / "cases.json"
    if cases.is_file():
        check_cases(cases, errors)
    else:
        warnings.append("evaluations/cases.json missing; no acceptance cases ship with the package")

    avatar = data.get("avatar")
    image = root / avatar if isinstance(avatar, str) else root / "__missing__"
    if not image.is_file():
        errors.append("avatar file missing")
    else:
        raw = image.read_bytes()
        if len(raw) > 500_000:
            errors.append(f"avatar exceeds 500KB: {len(raw)} bytes")
        elif len(raw) > 300_000:
            warnings.append(f"avatar is {len(raw)} bytes; consider recompressing before upload")
        if raw[:8] != b"\x89PNG\r\n\x1a\n":
            errors.append("avatar must be PNG")
        elif raw[12:16] != b"IHDR":
            errors.append("avatar PNG lacks a leading IHDR chunk")
        elif struct.unpack(">II", raw[16:24]) != (512, 512):
            errors.append("avatar must be 512x512")
    return errors, warnings


if __name__ == "__main__":
    problems, notes = verify()
    for note in notes:
        print(f"WARN: {note}")
    for problem in problems:
        print(f"ERROR: {problem}")
    if problems:
        sys.exit(1)
    print("WorkBuddy expert package passed structural validation.")
