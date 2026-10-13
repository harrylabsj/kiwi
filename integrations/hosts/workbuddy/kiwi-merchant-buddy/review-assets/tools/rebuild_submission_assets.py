#!/usr/bin/env python3
"""Safely reconstruct submitted Buddy package contents from retained exact ZIPs.

This copies/extracts into a caller-selected empty or matching staging directory.
It never regenerates platform/out packages and never overwrites differing files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


def repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".git").exists():
            return parent
    raise RuntimeError("Could not locate repository root")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_member(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(p in ("", ".", "..") for p in path.parts):
        raise ValueError(f"unsafe ZIP member path: {name!r}")
    if "\\" in name or "\x00" in name:
        raise ValueError(f"unsafe ZIP member path: {name!r}")
    return path


def reject_symlink_components(path: Path) -> Path:
    """Return an absolute lexical path after rejecting symlinks in every existing component."""
    expanded = path.expanduser()
    if ".." in expanded.parts:
        raise ValueError(f"refusing destination path with parent traversal: {path}")
    absolute = Path(os.path.abspath(expanded))
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current = current / component
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode):
            raise ValueError(f"refusing symlink destination path component: {current}")
    return absolute


def safe_mkdirs(path: Path) -> None:
    absolute = reject_symlink_components(path)
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current = current / component
        try:
            current.mkdir()
        except FileExistsError:
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise ValueError(f"refusing non-directory or symlink parent: {current}")


def install_bytes(path: Path, data: bytes, mode: int | None = None) -> None:
    path = reject_symlink_components(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        info = None
    if info is not None:
        if stat.S_ISLNK(info.st_mode):
            raise ValueError(f"refusing symlink target: {path}")
        if not stat.S_ISREG(info.st_mode) or path.read_bytes() != data:
            raise FileExistsError(f"refusing to overwrite differing or non-file target: {path}")
        return
    safe_mkdirs(path.parent)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, mode or 0o666)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        if mode:
            path.chmod(mode)
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise

def reconstruct(root: Path, destination: Path) -> dict[str, object]:
    registry_path = root / "integrations/hosts/workbuddy/kiwi-merchant-buddy/review-assets/registry.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    destination = reject_symlink_components(destination)
    safe_mkdirs(destination)
    extracted: list[dict[str, object]] = []

    for entry in registry["entries"]:
        kind = entry["kind"]
        group = "experts" if kind in ("expert", "team") else f"{kind}s"
        package_root = destination / group / f"{entry['slug']}-{entry['version']}"
        archive_path = root / entry["submission"]["archivePath"]
        if digest(archive_path.read_bytes()) != entry["submission"]["sha256"]:
            raise ValueError(f"submission ZIP hash mismatch: {archive_path}")
        members: list[str] = []
        with ZipFile(archive_path) as archive:
            seen: set[str] = set()
            for info in archive.infolist():
                rel = safe_member(info.filename)
                mode_bits = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode_bits):
                    raise ValueError(f"refusing symlink ZIP member: {info.filename}")
                if info.is_dir():
                    safe_mkdirs(package_root / Path(*rel.parts))
                    continue
                if info.filename in seen:
                    raise ValueError(f"duplicate ZIP member: {info.filename}")
                seen.add(info.filename)
                data = archive.read(info)
                install_bytes(package_root / Path(*rel.parts), data, stat.S_IMODE(mode_bits))
                members.append(info.filename)

        extracted.append({"slug": entry["slug"], "kind": kind, "members": len(members), "destination": str(package_root)})

    return {"status": "PASS", "sourceRegistry": str(registry_path.relative_to(root)), "destination": str(destination), "packageCount": len(extracted), "packages": extracted}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest-root", required=True, type=Path, help="staging directory for reconstructed files")
    args = parser.parse_args()
    root = repo_root()
    destination = reject_symlink_components(args.dest_root.expanduser())
    result = reconstruct(root, destination)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
