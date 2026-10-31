from __future__ import annotations

import hashlib
import stat
from dataclasses import dataclass
from pathlib import Path


class ImportBoundaryError(ValueError):
    """The Control import boundary rejected an unsafe or unsupported file."""


MAX_TEXT_IMPORT_BYTES = 10 * 1024 * 1024
SUPPORTED_TEXT_SUFFIXES = {".txt", ".text", ".md", ".markdown"}


@dataclass(frozen=True, slots=True)
class SelectedText:
    filename: str
    text: str
    sha256: str
    size_bytes: int


def read_control_selected_text(path: Path, max_bytes: int = MAX_TEXT_IMPORT_BYTES) -> SelectedText:
    """Read only a regular, non-symlink pilot fixture selected by Control.

    This is deliberately narrow until the sandboxed PDF/image decoder exists.
    MCP never receives this path; a trusted local Control action calls the same
    boundary.
    """
    if max_bytes < 1:
        raise ImportBoundaryError("max_bytes must be positive")
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise ImportBoundaryError("selected file is not readable") from exc
    if stat.S_ISLNK(metadata.st_mode):
        raise ImportBoundaryError("symbolic links are not accepted at the import boundary")
    if not stat.S_ISREG(metadata.st_mode):
        raise ImportBoundaryError("selected path must be a regular file")
    if metadata.st_size > max_bytes:
        raise ImportBoundaryError(f"selected file exceeds {max_bytes} bytes")
    if path.suffix.casefold() not in SUPPORTED_TEXT_SUFFIXES:
        raise ImportBoundaryError("pilot importer accepts only UTF-8 text fixtures")
    try:
        raw = path.read_bytes()
        text = raw.decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ImportBoundaryError("selected file is not valid UTF-8 text") from exc
    if len(raw) > max_bytes:
        raise ImportBoundaryError(f"selected file exceeds {max_bytes} bytes")
    return SelectedText(path.name, text, hashlib.sha256(raw).hexdigest(), len(raw))
