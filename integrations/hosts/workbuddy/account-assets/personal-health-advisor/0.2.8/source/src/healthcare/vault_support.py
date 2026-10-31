"""Low-level Vault support: errors, key derivation, hashing and file locks.

Kept separate from ``vault.py`` so the domain mixin modules can import these
without a package cycle; ``vault.py`` re-exports every name below.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, IO

from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


class VaultError(RuntimeError):
    pass


class VaultConflictError(VaultError):
    """A different writer committed after this Vault instance was opened."""


class SessionError(VaultError):
    pass


def _await_session_broker_ready(
    broker: subprocess.Popen[Any],
    ready_path: Path,
    diagnostics: IO[bytes],
    session_file: Path,
) -> None:
    """Detect a broker that dies during startup instead of failing silently.

    The broker touches ``ready_path`` once its socket is bound; if the process
    exits first, surface its stderr tail and remove the orphan session file.
    """
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if ready_path.exists():
            return
        if broker.poll() is not None:
            detail = ""
            try:
                diagnostics.seek(0)
                detail = diagnostics.read().decode("utf-8", errors="replace").strip()[-400:]
            except OSError:
                pass
            for path in (session_file, ready_path):
                try:
                    path.unlink()
                except OSError:
                    pass
            raise SessionError(
                f"ephemeral session broker failed to start: {detail or broker.returncode}"
            )
        time.sleep(0.02)


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    if not passphrase:
        raise VaultError("passphrase must not be empty")
    return PBKDF2HMAC(algorithm=SHA256(), length=32, salt=salt, iterations=600_000).derive(
        passphrase.encode("utf-8")
    )


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def approval_destination_target(destination: Path) -> str:
    return "destination:" + hashlib.sha256(str(destination).encode("utf-8")).hexdigest()


def _secure_mode(path: Path) -> None:
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


@contextmanager
def _exclusive_vault_lock(path: Path):
    """Serialize commits across local processes without exposing Vault contents.

    The lock contains no health data and is deliberately adjacent to the Vault,
    so all local CLI and daemon processes contend on the same target.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        _secure_mode(path)
        if os.name == "posix":
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        elif os.name == "nt":
            import msvcrt
            import time

            handle.seek(0)
            handle.write("0")
            handle.flush()
            handle.seek(0)
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    time.sleep(0.05)
        try:
            yield
        finally:
            if os.name == "posix":
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            elif os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
