#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import platform
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


AGENT_ID = "wechat-social-assistant"
VERSION = "1.1.0"


@dataclass(frozen=True)
class Check:
    id: str
    status: str
    detail: str


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check the local wechat-social-assistant environment.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    parser.add_argument("--project-root", type=Path, help="Path to a source checkout. Defaults to this repository.")
    parser.add_argument("--db", type=Path, help="Optional database path to inspect.")
    parser.add_argument("--obsidian-vault", type=Path, help="Optional Obsidian vault path to inspect.")
    args = parser.parse_args(argv)

    root = args.project_root or _default_project_root()
    checks = _run_checks(root, db_path=args.db, obsidian_vault=args.obsidian_vault)
    payload = {
        "agent_id": AGENT_ID,
        "version": VERSION,
        "project_root": str(root),
        "platform": platform.platform(),
        "overall": _overall_status(checks),
        "checks": [asdict(check) for check in checks],
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        _print_human(payload)
    return 0 if payload["overall"] in {"ok", "warn"} else 1


def _run_checks(root: Path, *, db_path: Path | None, obsidian_vault: Path | None) -> list[Check]:
    root = root.expanduser().resolve(strict=False)
    checks = [
        _python_version_check(),
        _cli_importable_check(root),
        _mcp_importable_check(root),
        _console_script_check(),
        _macos_capture_check(),
        _ocr_source_check(root),
        _watch_process_check(),
    ]
    if db_path is None:
        db_path = root / "data" / "social.db"
    checks.append(_path_check("database_path", db_path, required=False))
    checks.append(_path_check("captures_dir", db_path.parent / "captures", required=False))
    if obsidian_vault is not None:
        checks.append(_path_check("obsidian_vault", obsidian_vault, required=False))
    return checks


def _python_version_check() -> Check:
    version = sys.version_info
    if version >= (3, 11):
        return Check("python_version", "ok", f"{version.major}.{version.minor}.{version.micro}")
    return Check("python_version", "error", "Python 3.11 or newer is required.")


def _cli_importable_check(root: Path) -> Check:
    sys.path.insert(0, str(root))
    try:
        import wsa.cli  # noqa: F401
    except Exception as exc:
        return Check("cli_importable", "error", f"Cannot import wsa.cli: {exc}")
    return Check("cli_importable", "ok", "wsa.cli is importable from the selected project root.")


def _mcp_importable_check(root: Path) -> Check:
    sys.path.insert(0, str(root))
    try:
        from wsa import mcp_server
    except Exception as exc:
        return Check("mcp_importable", "error", f"Cannot import wsa.mcp_server: {exc}")
    tool_count = len(getattr(mcp_server, "MCP_TOOLS", ()))
    return Check("mcp_importable", "ok", f"wsa.mcp_server is importable with {tool_count} tools.")


def _console_script_check() -> Check:
    executable = shutil.which("wsa")
    if executable:
        return Check("console_script", "ok", executable)
    return Check("console_script", "warn", "wsa console script was not found; use python3 -m wsa.cli or install the package.")


def _macos_capture_check() -> Check:
    if platform.system() != "Darwin":
        return Check("macos_capture", "warn", "Screen capture and native OCR helpers currently target macOS.")
    if shutil.which("screencapture"):
        return Check("macos_capture", "ok", "macOS screencapture is available.")
    return Check("macos_capture", "error", "macOS screencapture command is missing.")


def _ocr_source_check(root: Path) -> Check:
    source = root / "tools" / "macos_ocr.swift"
    if source.exists():
        return Check("ocr_source", "ok", str(source))
    return Check("ocr_source", "warn", "tools/macos_ocr.swift is missing; OCR may not build from this checkout.")


def _watch_process_check() -> Check:
    try:
        result = subprocess.run(["pgrep", "-fl", "wsa.cli watch"], text=True, capture_output=True, check=False)
    except OSError as exc:
        return Check("watch_process", "warn", f"Cannot inspect watch process: {exc}")
    if result.returncode == 0 and result.stdout.strip():
        return Check("watch_process", "warn", result.stdout.strip().splitlines()[0])
    return Check("watch_process", "ok", "No wsa watch process detected.")


def _path_check(check_id: str, path: Path, *, required: bool) -> Check:
    resolved = path.expanduser().resolve(strict=False)
    if resolved.exists():
        return Check(check_id, "ok", str(resolved))
    status = "error" if required else "warn"
    return Check(check_id, status, f"{resolved} does not exist yet.")


def _overall_status(checks: list[Check]) -> str:
    statuses = {check.status for check in checks}
    if "error" in statuses:
        return "error"
    if "warn" in statuses:
        return "warn"
    return "ok"


def _print_human(payload: dict) -> None:
    print(f"{payload['agent_id']} {payload['version']} doctor: {payload['overall']}")
    for check in payload["checks"]:
        print(f"- {check['id']}: {check['status']} - {check['detail']}")


def _default_project_root() -> Path:
    return Path(__file__).resolve().parents[4]


if __name__ == "__main__":
    raise SystemExit(main())
