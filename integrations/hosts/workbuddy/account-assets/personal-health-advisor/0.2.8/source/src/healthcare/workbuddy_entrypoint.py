"""Local WorkBuddy MCP entrypoint using an already paired Agent profile.

The configuration holds routing information only. The agent token remains in
macOS Keychain and the Vault passphrase never enters WorkBuddy configuration.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

from .mcp_server import main as mcp_main


CONFIG_ENV = "HEALTHCARE_WORKBUDDY_CONFIG"
DEFAULT_CONFIG = Path.home() / ".config" / "healthcare" / "workbuddy.json"
_REQUIRED = ("socket", "agent_id", "host_id", "person_id")


def config_path() -> Path:
    return Path(os.environ.get(CONFIG_ENV, str(DEFAULT_CONFIG))).expanduser()


def load_config(path: Path | None = None) -> dict[str, str]:
    path = path or config_path()
    try:
        if path.is_symlink() or not path.is_file():
            raise ValueError("not a regular file")
        if os.name == "posix" and stat.S_IMODE(path.stat().st_mode) & 0o077:
            raise ValueError("permissions must be 0600")
        raw: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError(f"unable to read WorkBuddy local configuration: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError("WorkBuddy local configuration must be an object")
    config = {key: str(raw.get(key, "")).strip() for key in _REQUIRED}
    if any(not config[key] for key in _REQUIRED):
        raise ValueError("WorkBuddy local configuration is missing a required field")
    if not Path(config["socket"]).is_absolute():
        raise ValueError("WorkBuddy socket path must be absolute")
    return config


def write_config(path: Path, *, socket: Path, agent_id: str, host_id: str, person_id: str, replace: bool = False) -> Path:
    if not socket.is_absolute():
        raise ValueError("socket path must be absolute")
    if not all(value.strip() for value in (agent_id, host_id, person_id)):
        raise ValueError("agent_id, host_id and person_id are required")
    if path.exists() and not replace:
        raise ValueError("configuration already exists; pass --replace to update it")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps({"socket": str(socket), "agent_id": agent_id, "host_id": host_id, "person_id": person_id}, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, path)
    path.chmod(0o600)
    return path


def main(argv: list[str] | None = None) -> int:
    if argv:
        print("healthcare-workbuddy reads its local pairing configuration and accepts no arguments", file=sys.stderr)
        return 2
    try:
        config = load_config()
    except ValueError as exc:
        print(f"healthcare-workbuddy: {exc}", file=sys.stderr)
        return 2
    return mcp_main(["--socket", config["socket"], "--agent-id", config["agent_id"], "--host-id", config["host_id"], "--person-id", config["person_id"]])
