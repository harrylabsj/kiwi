#!/usr/bin/env python3
"""Repack the archived static WorkBuddy plugin cache as a labeled candidate ZIP."""
from hashlib import sha256
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "source"
OUTPUT = ROOT / "gaokao-advisor-1.0.0-cache-repack-candidate.zip"
STAMP = (2026, 1, 1, 0, 0, 0)

with zipfile.ZipFile(OUTPUT, "w") as archive:
    for path in sorted(SOURCE.rglob("*")):
        if not path.is_file() or path.name in {".DS_Store", ".gitkeep"}:
            continue
        relative = Path("gaokao-advisor") / path.relative_to(SOURCE)
        info = zipfile.ZipInfo(relative.as_posix(), date_time=STAMP)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes())

digest = sha256(OUTPUT.read_bytes()).hexdigest()
OUTPUT.with_suffix(OUTPUT.suffix + ".sha256").write_text(
    f"{digest}  {OUTPUT.name}\n", encoding="utf-8"
)
print(f"{OUTPUT}\n{digest}")
