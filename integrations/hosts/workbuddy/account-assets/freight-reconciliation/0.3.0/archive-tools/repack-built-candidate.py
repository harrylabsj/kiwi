#!/usr/bin/env python3
"""Build the pinned freight source tree and zip the generated plugin as a candidate."""
from hashlib import sha256
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "source"
OUTPUT = ROOT / "freight-reconciliation-0.3.0-source-rebuild-candidate.zip"
STAMP = (2026, 1, 1, 0, 0, 0)

with tempfile.TemporaryDirectory(prefix="freight-source-build-") as tmp:
    build_root = Path(tmp) / "source"
    shutil.copytree(SOURCE, build_root)
    subprocess.run(
        [sys.executable, str(build_root / "scripts" / "build_host_package.py")],
        cwd=build_root,
        check=True,
    )
    package = build_root / "dist" / "host-plugin" / "freight-reconciliation"
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(package.rglob("*")):
            if not path.is_file():
                continue
            relative = Path("freight-reconciliation") / path.relative_to(package)
            info = zipfile.ZipInfo(relative.as_posix(), date_time=STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = ((stat.S_IFREG | stat.S_IMODE(path.stat().st_mode)) << 16)
            archive.writestr(info, path.read_bytes())

digest = sha256(OUTPUT.read_bytes()).hexdigest()
OUTPUT.with_suffix(OUTPUT.suffix + ".sha256").write_text(
    f"{digest}  {OUTPUT.name}\n", encoding="utf-8"
)
print(f"{OUTPUT}\n{digest}")
