from __future__ import annotations

import importlib.metadata
from typing import Any


TARGET_PROTOCOL = "2026-07-28"
LEGACY_PROTOCOL = "2025-11-25"
TASKS_EXTENSION = "io.modelcontextprotocol/tasks"


def runtime_capabilities() -> dict[str, Any]:
    """Report observed local SDK capabilities; do not infer unsupported eras."""
    sdk_version = importlib.metadata.version("mcp")
    return {
        "sdk": {"package": "mcp", "version": sdk_version, "major_line": sdk_version.split(".", 1)[0]},
        "transport": {"stdio": True, "streamable_http": False, "legacy_sse": False},
        "observed_protocol": LEGACY_PROTOCOL,
        "target_protocol": TARGET_PROTOCOL,
        "tools": True,
        "resources": True,
        "structured_output": True,
        "server_discover": False,
        "tasks": False,
        "tasks_extension": TASKS_EXTENSION,
        "status": "legacy-baseline-verified",
    }
