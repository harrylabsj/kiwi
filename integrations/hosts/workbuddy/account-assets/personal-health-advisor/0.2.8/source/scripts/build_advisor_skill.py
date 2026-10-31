#!/usr/bin/env python3
"""Build the connector-free WorkBuddy Skill package for 个人健康管理顾问.

Output: dist/skill/personal-health-advisor/
  SKILL.md · references/ · scripts/health-advisor(.mjs) · wheels/{healthcare_mcp-<v>-py3-none-any.whl, requirements.txt}

The package carries no user data, no passphrase, no MCP/connector manifests and
no machine-specific paths; `check_delivery_boundary` enforces that.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "workbuddy" / "skill" / "personal-health-advisor"
DEFAULT_OUTPUT = ROOT / "dist" / "skill" / "personal-health-advisor"
TEXT_SUFFIXES = {".md", ".json", ".py", ".html", ".sh", ""}

BANNED = (
    re.compile(r"HEALTHCARE_PASSPHRASE\s*="),
    re.compile(r"(?i)api[_-]?key\s*[:=]"),
    re.compile(r"\bwrk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"connector-meta"),
    re.compile(r"\.mcp\.json"),
    re.compile(r"token-schema"),
    re.compile(r"localhost:\d{4}"),
    re.compile(r"user-profile-id-example"),
    re.compile(r"node_modules"),
)
# Inside the wheel only literal credential shapes are banned; identifiers such
# as an `api_key=` keyword argument are legitimate source code.
WHEEL_TEXT_BANNED = (
    re.compile(r"HEALTHCARE_PASSPHRASE\s*=\s*['\"][^'\"]+"),
    re.compile(r"\bwrk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"),
)


class SkillBuildError(RuntimeError):
    pass


MANAGED_VERSIONS = Path.home() / ".workbuddy" / "binaries" / "python" / "versions"


def managed_python() -> Path | None:
    """WorkBuddy's managed CPython; `versions/current` is a text file naming the active version."""
    current = MANAGED_VERSIONS / "current"
    try:
        version = current.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    candidate = MANAGED_VERSIONS / version / "bin" / "python3"
    return candidate if candidate.is_file() else None


def build_python() -> str:
    """Interpreter used to resolve dependency wheels.

    Binary wheels are CPython-version specific, and the launcher prefers
    WorkBuddy's managed CPython at run time, so build with that interpreter
    when it is installed (override with HEALTH_ADVISOR_BUILD_PYTHON).
    """
    override = os.environ.get("HEALTH_ADVISOR_BUILD_PYTHON")
    if override:
        return override
    managed = managed_python()
    return str(managed) if managed else sys.executable


def build_wheel(destination: Path, python: str | None = None) -> Path:
    """Build the application wheel and every runtime dependency into one bundle."""
    python = python or build_python()
    destination.mkdir(parents=True, exist_ok=True)
    for stale in destination.glob("*.whl"):
        stale.unlink()
    result = subprocess.run(
        [python, "-m", "pip", "wheel", f"{ROOT}[advisor]", "-w", str(destination), "--quiet", "--disable-pip-version-check"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise SkillBuildError(f"wheel build failed: {result.stderr.strip()[-400:]}")
    # pip normalizes the project name in wheel filenames (healthcare-mcp ->
    # healthcare_mcp), so match on the bare project stem, not a hyphen glob.
    wheels = sorted(wheel for wheel in destination.glob("*.whl") if wheel.name.startswith("healthcare"))
    if len(wheels) != 1:
        raise SkillBuildError("expected exactly one healthcare wheel")
    return wheels[0]


def _wheel_identity(wheel: Path) -> tuple[str, str]:
    try:
        with zipfile.ZipFile(wheel) as archive:
            metadata_name = next(name for name in archive.namelist() if name.endswith(".dist-info/METADATA"))
            metadata = archive.read(metadata_name).decode("utf-8")
    except (OSError, StopIteration, UnicodeDecodeError, zipfile.BadZipFile) as exc:
        raise SkillBuildError(f"invalid bundled wheel: {wheel.name}") from exc
    name = next((line[6:].strip() for line in metadata.splitlines() if line.startswith("Name: ")), "")
    version = next((line[9:].strip() for line in metadata.splitlines() if line.startswith("Version: ")), "")
    if not name or not version:
        raise SkillBuildError(f"wheel metadata is incomplete: {wheel.name}")
    return re.sub(r"[-_.]+", "-", name).lower(), version


def bundle_windows_wheels(destination: Path, python: str | None = None) -> None:
    """Bundle pinned Windows x86_64 wheels for WorkBuddy x64/ARM64 emulation."""
    python = python or build_python()
    versions = dict(_wheel_identity(wheel) for wheel in destination.glob("*.whl"))
    dependencies = sorted((name, version) for name, version in versions.items() if name != "healthcare")
    with tempfile.TemporaryDirectory(prefix="health-advisor-pins-") as temp:
        pins = Path(temp) / "requirements.txt"
        pins.write_text("".join(f"{name}=={version}\n" for name, version in dependencies), encoding="utf-8")
        for minor in ("11", "13"):
            result = subprocess.run(
                [python, "-m", "pip", "download", "-r", str(pins), "--dest", str(destination),
                 "--no-deps", "--only-binary=:all:", "--platform", "win_amd64",
                 "--python-version", f"3.{minor}", "--implementation", "cp",
                 "--abi", f"cp3{minor}", "--abi", "abi3", "--abi", "none",
                 "--quiet", "--disable-pip-version-check"],
                capture_output=True, text=True, check=False,
            )
            if result.returncode != 0:
                raise SkillBuildError(f"Windows CPython 3.{minor} wheel download failed: {result.stderr.strip()[-400:]}")


def write_requirements_lock(destination: Path) -> Path:
    """Create one pinned requirement with all platform hashes per package."""
    rows: dict[tuple[str, str], set[str]] = {}
    for wheel in sorted(destination.glob("*.whl")):
        name, version = _wheel_identity(wheel)
        digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
        rows.setdefault((name, version), set()).add(digest)
    if not rows:
        raise SkillBuildError("no bundled wheels were built")
    lock = destination / "requirements.txt"
    lock.write_text("".join(
        f"{name}=={version}" + "".join(f" --hash=sha256:{digest}" for digest in sorted(digests)) + "\n"
        for (name, version), digests in sorted(rows.items())
    ), encoding="utf-8")
    return lock


def check_delivery_boundary(package: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(package.rglob("*")):
        if path.is_symlink():
            raise SkillBuildError(f"symlinks are not allowed in the Skill package: {path.relative_to(package)}")
        if path.is_dir():
            continue
        files.append(path)
        if path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            continue
        if path.suffix.lower() == ".whl":
            try:
                with zipfile.ZipFile(path) as archive:
                    names = archive.namelist()
                    if any(name.endswith(".mcp.json") or "connector-meta" in name or "token-schema" in name for name in names):
                        raise SkillBuildError(f"wheel contains a prohibited runtime manifest: {path.name}")
                    for name in names:
                        if not name.startswith("healthcare/") or Path(name).suffix.lower() not in TEXT_SUFFIXES:
                            continue
                        text = archive.read(name).decode("utf-8")
                        if str(ROOT) in text:
                            raise SkillBuildError(f"wheel references a local absolute path: {path.name}:{name}")
                        for pattern in WHEEL_TEXT_BANNED:
                            if pattern.search(text):
                                raise SkillBuildError(f"wheel matches a banned pattern ({pattern.pattern}): {path.name}:{name}")
            except zipfile.BadZipFile as exc:
                raise SkillBuildError(f"invalid bundled wheel: {path.name}") from exc
            continue
        text = path.read_text(encoding="utf-8")
        if str(ROOT) in text:
            raise SkillBuildError(f"package text references a local absolute path: {path.relative_to(package)}")
        for pattern in BANNED:
            if pattern.search(text):
                raise SkillBuildError(f"package text matches a banned pattern ({pattern.pattern}): {path.relative_to(package)}")
    return files


def build_skill(output: Path = DEFAULT_OUTPUT, python: str | None = None) -> Path:
    if not SOURCE.is_dir():
        raise SkillBuildError("skill source directory is missing")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    shutil.copy2(SOURCE / "SKILL.md", output / "SKILL.md")
    shutil.copytree(SOURCE / "references", output / "references")
    (output / "scripts").mkdir()
    launcher = output / "scripts" / "health-advisor"
    shutil.copy2(SOURCE / "scripts" / "health-advisor", launcher)
    launcher.chmod(0o755)
    mcp_launcher = output / "scripts" / "health-advisor-mcp.mjs"
    shutil.copy2(SOURCE / "scripts" / "health-advisor-mcp.mjs", mcp_launcher)
    wheels_dir = output / "wheels"
    build_wheel(wheels_dir, python)
    bundle_windows_wheels(wheels_dir, python)
    write_requirements_lock(wheels_dir)
    required = ("SKILL.md", "references/commands.md", "references/security.md", "references/boundaries.md", "scripts/health-advisor", "scripts/health-advisor-mcp.mjs", "wheels/requirements.txt")
    for relative in required:
        if not (output / relative).is_file():
            raise SkillBuildError(f"skill package is missing {relative}")
    check_delivery_boundary(output)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)
    try:
        output = build_skill(args.output)
    except SkillBuildError as exc:
        print(f"build_advisor_skill: {exc}", file=sys.stderr)
        return 2
    count = sum(1 for path in output.rglob("*") if path.is_file())
    print(f"已生成本地 Skill 包：{output.relative_to(ROOT) if output.is_relative_to(ROOT) else output}（{count} 个文件；无口令、市场连接器清单或本机路径）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
