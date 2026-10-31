"""Local path policy used by the MCP transport boundary.

The CLI and Python API intentionally remain flexible because a user may keep
their database outside the checkout.  The MCP process is a different trust
boundary: tool arguments must not turn it into an arbitrary local file reader.
The launcher supplies ``WSA_MCP_ENFORCE_PATHS=1`` and a trusted
``WSA_ALLOWED_ROOT``; all file-like MCP arguments are then resolved below that
root (after symlink resolution).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


class PathPolicyError(ValueError):
    """Raised when an MCP path escapes its configured trusted root."""


def mcp_path_policy_enabled() -> bool:
    value = os.environ.get("WSA_MCP_ENFORCE_PATHS", "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def mcp_allowed_root(*, base: Path | str | None = None) -> Path:
    configured = os.environ.get("WSA_ALLOWED_ROOT")
    root = Path(configured).expanduser() if configured else Path(base or Path.cwd())
    return root.resolve(strict=False)


def resolve_mcp_path(
    value: Any,
    *,
    default: Path | str,
    label: str,
    base: Path | str | None = None,
) -> Path:
    """Resolve an MCP path and enforce the launcher-provided root when enabled."""

    candidate = Path(str(value)).expanduser() if value not in (None, "") else Path(default)
    resolved = candidate.resolve(strict=False)
    if not mcp_path_policy_enabled():
        return resolved

    root = mcp_allowed_root(base=base)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise PathPolicyError(
            f"{label} must stay under the configured WSA_ALLOWED_ROOT ({root})"
        ) from exc
    return resolved


def configure_mcp_path_policy(*, root: Path | str | None = None) -> Path:
    """Enable the default stdio policy for a standalone MCP process."""

    allowed = Path(root or os.environ.get("WSA_ALLOWED_ROOT") or Path.cwd()).expanduser().resolve(strict=False)
    os.environ.setdefault("WSA_ALLOWED_ROOT", str(allowed))
    os.environ.setdefault("WSA_MCP_ENFORCE_PATHS", "1")
    return allowed
