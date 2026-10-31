"""Per-user local data directory for the advisor Skill.

Everything the Skill writes (Vaults, settings, passphrase file, workbench
snapshots) lives under one user-level directory so removal is one folder.
`HEALTH_ADVISOR_DATA_DIR` overrides it for tests and advanced users.
"""

from __future__ import annotations

import os
import platform
import tempfile
from pathlib import Path

APP_DIR_NAME = "PersonalHealthAdvisor"
DATA_DIR_ENV = "HEALTH_ADVISOR_DATA_DIR"
RUNTIME_DIR_ENV = "HEALTH_ADVISOR_RUNTIME_DIR"


def data_dir() -> Path:
    """Vault, settings, passphrase copy and demo data.

    On macOS and Linux this is ``~/.local/share/PersonalHealthAdvisor`` rather
    than ``~/Library/Application Support``: WorkBuddy's Bash sandbox forbids
    deleting or renaming files outside a short allowlist of home directories
    (verified 2026-09-15 against its seatbelt profile), and ``~/.local`` is on
    that list, so atomic Vault saves (temp file + rename) keep working when
    the Skill runs inside WorkBuddy.
    """
    override = os.environ.get(DATA_DIR_ENV)
    if override:
        return Path(override).expanduser()
    home = Path.home()
    if platform.system() == "Windows":
        base = os.environ.get("LOCALAPPDATA")
        return (Path(base) if base else home / "AppData" / "Local") / APP_DIR_NAME
    base = os.environ.get("XDG_DATA_HOME")
    return (Path(base) if base else home / ".local" / "share") / APP_DIR_NAME


def runtime_dir() -> Path:
    """Rebuildable private Python environments (one per interpreter version)."""
    override = os.environ.get(RUNTIME_DIR_ENV)
    if override:
        return Path(override).expanduser()
    home = Path.home()
    if platform.system() == "Windows":
        base = os.environ.get("LOCALAPPDATA")
        return (Path(base) if base else home / "AppData" / "Local") / APP_DIR_NAME / "runtime"
    base = os.environ.get("XDG_CACHE_HOME")
    return (Path(base) if base else home / ".cache") / APP_DIR_NAME


def ensure_data_dir() -> Path:
    path = data_dir()
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    return path


def settings_path() -> Path:
    return data_dir() / "settings.json"


def passphrase_path() -> Path:
    return data_dir() / "passphrase"


def live_vault_path(configured: str | None = None) -> Path:
    """The personal Vault: settings, then `HEALTHCARE_VAULT` (existing installs), then the data dir."""
    if configured:
        return Path(configured).expanduser()
    override = os.environ.get("HEALTHCARE_VAULT")
    if override:
        return Path(override).expanduser()
    return data_dir() / "family.vault"


def demo_vault_path() -> Path:
    return data_dir() / "demo.vault"


def demo_marker_path() -> Path:
    return data_dir() / "demo.json"


def write_private_text(path: Path, text: str) -> Path:
    """Atomically write private text without following a predictable temp link."""
    if path.is_symlink():
        raise OSError("refusing to replace a symbolic-link output path")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temporary, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    except BaseException:
        # A failed write leaves its private temp file behind on purpose: this
        # tool never deletes files, and the leftover is 0600 and harmless.
        raise
    return path
