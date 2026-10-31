#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


READ_COMMANDS = {
    "status",
    "audit",
    "contacts",
    "feedback-list",
    "brief",
    "quality",
    "dashboard",
    "cockpit",
    "candidates",
    "sources",
    "weekly-report",
    "next",
    "suggest",
    "profiles",
    "ocr-image",
    "connectors",
}
WRITE_COMMANDS = {
    "init",
    "ingest",
    "capture",
    "quick-capture",
    "import-image",
    "ingest-image",
    "analyze",
    "export-obsidian",
    "import-obsidian",
    "import-source",
    "import-wechat-archive",
    "feedback",
    "candidate-confirm",
    "export-data",
    "delete-contact",
    "watch",
    "watch-interval",
    "stop-watch",
    "stop",
    "reset",
    "backup",
    "ocr-review",
}
ALL_COMMANDS = tuple(sorted(READ_COMMANDS | WRITE_COMMANDS))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Portable wrapper for confirmed wsa CLI calls.")
    parser.add_argument("--list-commands", action="store_true", help="List allowed wsa commands and exit.")
    parser.add_argument("--project-root", type=Path, help="Run from a specific source checkout.")
    parser.add_argument("--confirm", action="store_true", help="Required for commands that write files, mutate data, or control processes.")
    parser.add_argument("args", nargs=argparse.REMAINDER, help="Arguments to pass after python3 -m wsa.cli.")
    parsed = parser.parse_args(argv)

    if parsed.list_commands:
        print("\n".join(ALL_COMMANDS))
        return 0
    if not parsed.args:
        parser.error("provide a wsa command or use --list-commands")

    command = parsed.args[0]
    if command not in ALL_COMMANDS:
        parser.error(f"unsupported wsa command: {command}")
    if _requires_confirmation(command, parsed.args) and not parsed.confirm:
        parser.error(f"{command} requires --confirm because it can write local state or control a process")

    project_root = parsed.project_root or Path(__file__).resolve().parents[4]
    return subprocess.call([sys.executable, "-m", "wsa.cli", *parsed.args], cwd=project_root)


def _requires_confirmation(command: str, args: list[str]) -> bool:
    if command in WRITE_COMMANDS:
        return True
    if command == "cockpit" and ("--dry-run" not in args[1:] or "--out" in args[1:]):
        return True
    return command == "candidates" and "--sync" in args[1:]


if __name__ == "__main__":
    raise SystemExit(main())
