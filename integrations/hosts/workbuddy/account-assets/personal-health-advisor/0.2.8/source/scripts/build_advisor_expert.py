#!/usr/bin/env python3
"""Assemble, validate and optionally zip the 个人健康管理顾问 WorkBuddy expert.

dist/expert/personal-health-advisor-expert/ = expert source + dist/skill package.
The expert bundles its own stdio `.mcp.json` (the Skill launcher's `mcp`
subcommand, for the embedded live workbench) and declares no connector or OAuth
dependency; the Skill package itself is bundled.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_advisor_skill import DEFAULT_OUTPUT as SKILL_OUTPUT, SkillBuildError, build_skill  # noqa: E402

EXPERT_NAME = "personal-health-advisor-expert"
SKILL_NAME = "personal-health-advisor"
SOURCE = ROOT / "workbuddy" / "expert" / EXPERT_NAME
DEFAULT_OUTPUT = ROOT / "dist" / "expert" / EXPERT_NAME
REQUIRED = (
    ".codebuddy-plugin/plugin.json",
    ".mcp.json",
    f"agents/{SKILL_NAME}.md",
    f"avatars/{SKILL_NAME}.png",
    "README.md",
    "SUBMISSION.md",
    f"skills/{SKILL_NAME}/SKILL.md",
    f"skills/{SKILL_NAME}/scripts/health-advisor",
    f"skills/{SKILL_NAME}/scripts/health-advisor-mcp.mjs",
)
REQUIRED_FIELDS = (
    "name", "version", "description", "author", "agents", "agentName", "expertType", "skills", "displayName",
    "profession", "displayDescription", "avatar", "categoryId", "defaultInitPrompt", "plugin", "tags", "quickPrompts",
)
SENSITIVE = re.compile(r"(?i)(HEALTHCARE_(?:PASSPHRASE|LLM_API_KEY)\s*=|api[_-]?key\s*[:=]|authorization\s*[:=]|\bsk-[a-z0-9_-]{8,}|\bwrk-[a-z0-9_-]{8,})")


class ExpertBuildError(RuntimeError):
    pass


def validate_expert(root: Path) -> list[Path]:
    if not root.is_dir() or root.is_symlink():
        raise ExpertBuildError("expert root must be a regular directory")
    for relative in REQUIRED:
        path = root / relative
        if not path.is_file() or path.is_symlink():
            raise ExpertBuildError(f"required expert file missing: {relative}")
    try:
        plugin = json.loads((root / ".codebuddy-plugin/plugin.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExpertBuildError("plugin.json is invalid") from exc
    missing = [field for field in REQUIRED_FIELDS if field not in plugin]
    if missing:
        raise ExpertBuildError(f"plugin.json is missing: {', '.join(missing)}")
    if plugin["name"] != EXPERT_NAME or plugin["plugin"] != EXPERT_NAME or plugin["expertType"] != "agent":
        raise ExpertBuildError("plugin name/plugin/expertType configuration is invalid")
    dependencies = plugin.get("dependencies")
    if dependencies != {"mcpServers": "./.mcp.json"}:
        raise ExpertBuildError("expert must declare exactly its bundled .mcp.json (no connectors, no OAuth)")
    try:
        mcp = json.loads((root / ".mcp.json").read_text(encoding="utf-8"))
        servers = mcp["mcpServers"]
        server = servers[SKILL_NAME]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ExpertBuildError("bundled .mcp.json is invalid") from exc
    args = server.get("args") or []
    if len(servers) != 1 or server.get("type") != "stdio" or server.get("command") != "node" or args != [f"./skills/{SKILL_NAME}/scripts/health-advisor-mcp.mjs"]:
        raise ExpertBuildError("bundled .mcp.json must start the cross-platform Node MCP bootstrap from the expert package")
    runtime = server.get("runtime")
    if runtime != {"type": "node", "version": "20"}:
        raise ExpertBuildError("bundled .mcp.json must declare the Node 20 runtime")
    if "env" in server:
        raise ExpertBuildError("bundled .mcp.json must not inject environment variables")
    if plugin["skills"] != [f"./skills/{SKILL_NAME}"] or plugin["agents"] != [f"./agents/{SKILL_NAME}.md"]:
        raise ExpertBuildError("expert must bundle exactly the personal-health-advisor skill and agent")
    if len(plugin["tags"]) != 3 or len(plugin["quickPrompts"]) != 3:
        raise ExpertBuildError("expert tags and quick prompts must each contain exactly three items")
    if plugin["defaultInitPrompt"]["zh"] != plugin["quickPrompts"][0]["zh"]:
        raise ExpertBuildError("defaultInitPrompt must match the first quick prompt")
    zh_description = plugin["displayDescription"].get("zh", "")
    if not 40 <= len(zh_description) <= 50:
        raise ExpertBuildError(f"Chinese display description must contain 40-50 characters (has {len(zh_description)})")
    if plugin["profession"]["zh"] != "个人健康管理顾问":
        raise ExpertBuildError("expert profession (the card title in WorkBuddy) must be 个人健康管理顾问")
    avatar = root / plugin["avatar"]
    if avatar.suffix.lower() not in {".png", ".jpg", ".jpeg"} or avatar.stat().st_size > 500 * 1024:
        raise ExpertBuildError("expert avatar must be a PNG/JPG no larger than 500KB")
    skill_meta = (root / f"skills/{SKILL_NAME}/SKILL.md").read_text(encoding="utf-8")
    if not skill_meta.startswith("---") or f"name: {SKILL_NAME}" not in skill_meta:
        raise ExpertBuildError("bundled SKILL.md frontmatter is invalid")
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ExpertBuildError(f"symlinks are not allowed: {path.relative_to(root)}")
        if path.is_dir():
            continue
        files.append(path)
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".whl"}:
            continue
        text = path.read_text(encoding="utf-8")
        if SENSITIVE.search(text):
            raise ExpertBuildError(f"expert contains a sensitive credential pattern: {path.relative_to(root)}")
        if str(ROOT) in text:
            raise ExpertBuildError(f"expert contains a local absolute path: {path.relative_to(root)}")
    return files


def build_expert(output: Path = DEFAULT_OUTPUT, *, skill_output: Path = SKILL_OUTPUT, rebuild_skill: bool = True) -> Path:
    if rebuild_skill or not (skill_output / "SKILL.md").exists():
        build_skill(skill_output)
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(SOURCE, output)
    shutil.copytree(skill_output, output / "skills" / SKILL_NAME)
    validate_expert(output)
    return output


def package_expert(output_dir: Path) -> tuple[Path, str]:
    plugin = json.loads((output_dir / ".codebuddy-plugin/plugin.json").read_text(encoding="utf-8"))
    archive = output_dir.parent / f"{EXPERT_NAME}-{plugin['version']}.zip"
    archive.unlink(missing_ok=True)
    result = subprocess.run(["zip", "-q", "-r", str(archive), EXPERT_NAME], cwd=output_dir.parent, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise ExpertBuildError(result.stderr.strip() or "unable to create the expert zip")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.stat().st_size}  {archive.name}\n", encoding="utf-8")
    return archive, digest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--zip", action="store_true", help="also produce the upload ZIP and its SHA-256")
    args = parser.parse_args(argv)
    try:
        output = build_expert(args.output)
        print(f"已生成专家包：{output.relative_to(ROOT) if output.is_relative_to(ROOT) else output}/")
        if args.zip:
            archive, digest = package_expert(output)
            print(f"已生成发布候选包：{archive}\nSHA-256：{digest}")
    except (SkillBuildError, ExpertBuildError) as exc:
        print(f"build_advisor_expert: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
