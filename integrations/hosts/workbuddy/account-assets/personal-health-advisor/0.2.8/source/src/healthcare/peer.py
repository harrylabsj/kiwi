from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
import os
import socket
import subprocess
import sys

# macOS exposes LOCAL_PEERPID (option 2) on AF_UNIX sockets. It returns the
# kernel-verified PID of the process at the other end of the connection, so a
# stolen capability cannot be replayed from a different process.
_MACOS_LOCAL_PEERPID = 2
_MACOS_SOL_LOCAL = 0


def peer_pid(connection: socket.socket) -> int | None:
    """Return the connecting peer's PID as reported by the kernel.

    macOS only; returns ``None`` on other platforms or when the option is
    unavailable. Callers must fall back to credential-only authentication when
    this is ``None``.
    """
    if sys.platform != "darwin":
        return None
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        pid = ctypes.c_int(0)
        size = ctypes.c_int(ctypes.sizeof(pid))
        result = libc.getsockopt(
            connection.fileno(),
            _MACOS_SOL_LOCAL,
            _MACOS_LOCAL_PEERPID,
            ctypes.byref(pid),
            ctypes.byref(size),
        )
        if result != 0 or size.value != ctypes.sizeof(pid):
            return None
        return int(pid.value)
    except (OSError, AttributeError, ValueError):
        return None


def executable_path_for_pid(pid: int) -> str | None:
    """Resolve the executable path for a live process (macOS ``ps -o comm=``)."""
    if sys.platform != "darwin":
        return None
    try:
        result = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "comm="],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    path = result.stdout.strip()
    return path or None


def executable_digest_for_pid(pid: int) -> str | None:
    """SHA-256 of the executable backing ``pid``, or ``None`` if unresolvable."""
    path = executable_path_for_pid(pid)
    if not path or not os.path.isfile(path):
        return None
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(64 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def executable_digest() -> str | None:
    """SHA-256 of this process's own executable (used by the Agent client)."""
    return executable_digest_for_pid(os.getpid())
