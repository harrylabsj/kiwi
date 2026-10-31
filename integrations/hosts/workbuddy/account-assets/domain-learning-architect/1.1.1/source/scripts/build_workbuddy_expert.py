#!/usr/bin/env python3
"""Build a UTF-8 ZIP with the WorkBuddy expert structure at archive root."""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

from verify_workbuddy_expert import ROOT, verify


OUTPUT = ROOT.parents[1] / "outputs" / "domain-navigator-workbuddy-official.zip"
EXCLUDED_NAMES = {".DS_Store", "Thumbs.db"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".swp"}


def shippable(file: Path) -> bool:
    return (
        file.is_file()
        and "__pycache__" not in file.parts
        and file.name not in EXCLUDED_NAMES
        and file.suffix not in EXCLUDED_SUFFIXES
    )


def main() -> int:
    problems, notes = verify()
    for note in notes:
        print(f"WARN: {note}")
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(ROOT.rglob("*")):
            if shippable(file):
                archive.write(file, file.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(OUTPUT) as archive:
        if archive.testzip() is not None:
            print("ERROR: ZIP integrity check failed")
            return 1
    print(OUTPUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
