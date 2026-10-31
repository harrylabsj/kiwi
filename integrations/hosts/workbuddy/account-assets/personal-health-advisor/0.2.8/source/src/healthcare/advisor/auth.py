"""Vault passphrase handling for the Skill path.

The passphrase is never a command argument and never appears in stdout,
stderr, backups or the workbench. The only input path is a local file the
user wrote themselves (`auth init <file>` / `auth import <file>`); after that
the Skill keeps a 0600 copy in its data directory. `HEALTHCARE_PASSPHRASE`
in the environment wins over the file for people who already run healthCare.
"""

from __future__ import annotations

import os
from pathlib import Path

from ..vault import VaultError, VaultStore
from .paths import passphrase_path, write_private_text

PASSPHRASE_ENV = "HEALTHCARE_PASSPHRASE"
DEMO_PASSPHRASE = "demo-vault-not-a-secret"
MIN_PASSPHRASE_LENGTH = 8


class AuthError(ValueError):
    """Missing or unusable authorization (exit code 3)."""


def read_passphrase_file(path: Path) -> str:
    """Read a one-line passphrase file written by the user; never echo contents."""
    try:
        if path.is_symlink() or not path.is_file():
            raise AuthError("口令文件必须是普通文件")
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise AuthError("无法读取口令文件") from exc
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) != 1:
        raise AuthError("口令文件应只包含一行口令")
    passphrase = lines[0].strip()
    if len(passphrase) < MIN_PASSPHRASE_LENGTH:
        raise AuthError(f"口令至少 {MIN_PASSPHRASE_LENGTH} 个字符")
    return passphrase


def stored_passphrase(path: Path | None = None) -> str | None:
    path = path or passphrase_path()
    if not path.exists() or path.stat().st_size == 0:
        return None
    if os.name == "posix" and (path.stat().st_mode & 0o077):
        raise AuthError("本地口令文件权限不是 0600；请删除后重新 auth import")
    try:
        return read_passphrase_file(path)
    except AuthError as exc:
        raise AuthError("本地口令文件损坏；请重新 auth import") from exc


def passphrase_source() -> str:
    if os.environ.get(PASSPHRASE_ENV):
        return "env"
    path = passphrase_path()
    if path.exists() and path.stat().st_size > 0:
        return "file"
    return "none"


def resolve_passphrase(mode: str) -> str:
    if mode == "demo":
        return DEMO_PASSPHRASE
    value = os.environ.get(PASSPHRASE_ENV)
    if value:
        return value
    stored = stored_passphrase()
    if stored:
        return stored
    raise AuthError("尚未配置本机档案口令：把口令保存为本机文件后执行 auth init <文件>（新档案）或 auth import <文件>（已有档案）")


def store_passphrase(passphrase: str) -> Path:
    return write_private_text(passphrase_path(), passphrase + "\n")


def revoke_passphrase() -> bool:
    """Blank the stored copy (0600, zero bytes). This tool never deletes files."""
    path = passphrase_path()
    if not path.exists() or path.stat().st_size == 0:
        return False
    write_private_text(path, "")
    return True


def open_vault(path: Path, passphrase: str) -> VaultStore:
    if not path.exists():
        raise AuthError(f"档案不存在：{path.name}；用 auth init <口令文件> 创建")
    try:
        return VaultStore.open(path, passphrase)
    except VaultError as exc:
        raise AuthError("无法打开档案：口令不正确或文件损坏") from exc
