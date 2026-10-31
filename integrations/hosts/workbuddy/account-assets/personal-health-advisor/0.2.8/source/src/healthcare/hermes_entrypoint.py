"""Zero-config Hermes plugin entrypoint for healthCare.

Bootstraps a fully local stack under ``HEALTHCARE_HOME`` (the plugin data
directory when launched from the Hermes plugin package, otherwise
``~/.local/share/healthcare``) and then runs the stdio MCP server:

1. Create the encrypted Vault if missing, with a generated random passphrase
   stored in a 0600 file next to the Vault (never in argv, never printed).
2. Ensure a default person profile (``person.local``) exists.
3. Start the authenticated local IPC daemon on ``$HEALTHCARE_HOME/daemon.sock``
   if it is not already answering.
4. Pair a local Agent (token lives in the macOS Keychain only; the pairing
   profile is persisted as non-secret JSON for reuse across restarts).
5. Run the stdio MCP server against that daemon.

No network access, no accounts, no cloud sync. All state stays under
HEALTHCARE_HOME except the agent token, which lives in the macOS Keychain.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path

from .mcp_server import main as mcp_main
from .trust import MacOSKeychain, TrustManager
from .vault import VaultStore

SCOPES = ["observations.read", "documents.read", "analytics.read", "records.write"]
DEFAULT_PERSON_ID = "person.local"
DEFAULT_PERSON_NAME = "Me"
HOST_ID = "hermes-plugin"
AGENT_DISPLAY_NAME = "Hermes plugin (healthcare)"


def home() -> Path:
    override = os.environ.get("HEALTHCARE_HOME", "").strip()
    path = Path(override).expanduser() if override else Path.home() / ".local" / "share" / "healthcare"
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def _passphrase(home_dir: Path) -> str:
    from_env = os.environ.get("HEALTHCARE_PASSPHRASE", "").strip()
    if from_env:
        return from_env
    path = home_dir / ".vault-passphrase"
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    value = secrets.token_urlsafe(32)
    path.write_text(value + "\n", encoding="utf-8")
    path.chmod(0o600)
    return value


def _store(home_dir: Path, passphrase: str) -> VaultStore:
    return VaultStore.open(home_dir / "family.vault", passphrase)


def _socket_alive(socket_path: Path) -> bool:
    if not socket_path.exists():
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(1.0)
            probe.connect(str(socket_path))
        return True
    except OSError:
        return False


def _ensure_daemon(home_dir: Path, passphrase: str, socket_path: Path) -> None:
    if _socket_alive(socket_path):
        return
    env = dict(os.environ)
    env["HEALTHCARE_PASSPHRASE"] = passphrase  # via env so it never appears in argv
    subprocess.Popen(  # noqa: S603 - fixed local interpreter + module, no shell
        [sys.executable, "-m", "healthcare", "daemon", "--vault", str(home_dir / "family.vault"), "--socket", str(socket_path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env=env,
    )
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if _socket_alive(socket_path):
            return
        time.sleep(0.25)
    raise RuntimeError(f"healthcare daemon did not start on {socket_path}")


def _agent_state_path(home_dir: Path) -> Path:
    return home_dir / "agent.json"


def _ensure_paired_agent(home_dir: Path, passphrase: str) -> dict[str, str]:
    keychain = MacOSKeychain()
    state_path = _agent_state_path(home_dir)
    state: dict[str, str] = {}
    if state_path.is_file():
        try:
            raw = json.loads(state_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                state = {k: str(v) for k, v in raw.items() if isinstance(v, str)}
        except (OSError, json.JSONDecodeError):
            state = {}
    agent_id = state.get("agent_id", "")
    if agent_id and keychain.get(TrustManager.SERVICE, agent_id):
        return {"agent_id": agent_id, "host_id": state.get("host_id", HOST_ID), "person_id": state.get("person_id", DEFAULT_PERSON_ID)}

    store = _store(home_dir, passphrase)
    manager = TrustManager(store, keychain)
    if agent_id:
        try:
            manager.revoke_agent(agent_id)
        except Exception:
            pass
    profile, _token = manager.pair_agent(
        AGENT_DISPLAY_NAME,
        HOST_ID,
        secrets.token_hex(32),
        [DEFAULT_PERSON_ID],
        SCOPES,
    )
    state = {"agent_id": profile.agent_id, "host_id": HOST_ID, "person_id": DEFAULT_PERSON_ID}
    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, state_path)
    return state


def main(argv: list[str] | None = None) -> int:
    if argv:
        print("healthcare-hermes takes no arguments; configure via HEALTHCARE_HOME", file=sys.stderr)
        return 2
    if sys.platform != "darwin":
        print("healthcare-hermes currently supports macOS only (agent pairing uses the macOS Keychain)", file=sys.stderr)
        return 2
    home_dir = home()
    passphrase = _passphrase(home_dir)
    vault_path = home_dir / "family.vault"
    if not vault_path.exists():
        VaultStore.create(vault_path, passphrase)
    store = _store(home_dir, passphrase)
    store.ensure_person(DEFAULT_PERSON_ID, DEFAULT_PERSON_NAME)
    socket_path = home_dir / "daemon.sock"
    _ensure_daemon(home_dir, passphrase, socket_path)
    agent = _ensure_paired_agent(home_dir, passphrase)
    return mcp_main([
        "--socket", str(socket_path),
        "--agent-id", agent["agent_id"],
        "--host-id", agent["host_id"],
        "--person-id", agent["person_id"],
    ])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
