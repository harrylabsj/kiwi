from __future__ import annotations

import hashlib
import hmac
import platform
import secrets
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol

from .models import new_id, now_iso
from .vault import VaultError, VaultStore


class SecretStore(Protocol):
    def get(self, service: str, account: str) -> str | None: ...
    def set(self, service: str, account: str, value: str) -> None: ...
    def delete(self, service: str, account: str) -> None: ...


class MemoryKeychain:
    """Deterministic keychain substitute for tests and local protocol spikes."""

    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    def get(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def set(self, service: str, account: str, value: str) -> None:
        self.values[(service, account)] = value

    def delete(self, service: str, account: str) -> None:
        self.values.pop((service, account), None)


def _shell_word(value: str) -> str:
    """Quote a value for the `security -i` line protocol when needed."""
    if value and not any(character.isspace() or character in '"\\' for character in value):
        return value
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


class MacOSKeychain:
    """Small adapter over macOS `security`; never stores secrets in config files."""
    def __init__(self, service: str = "healthCare") -> None:
        self.service = service
        if platform.system() != "Darwin":
            raise VaultError("MacOSKeychain is only available on macOS")

    def get(self, service: str, account: str) -> str | None:
        result = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return None
        return result.stdout.rstrip("\n")

    def set(self, service: str, account: str, value: str) -> None:
        # `security -i` reads the subcommand from stdin so the token never
        # appears in argv; `-w` without an argument stores an empty password.
        command = (
            f"add-generic-password -U -s {_shell_word(service)} "
            f"-a {_shell_word(account)} -w {_shell_word(value)}\n"
        )
        result = subprocess.run(
            ["/usr/bin/security", "-i"],
            check=False,
            capture_output=True,
            text=True,
            input=command,
        )
        if result.returncode != 0:
            raise VaultError("unable to write the agent token into the macOS Keychain")

    def delete(self, service: str, account: str) -> None:
        subprocess.run(
            ["/usr/bin/security", "delete-generic-password", "-s", service, "-a", account],
            check=False,
            capture_output=True,
            text=True,
        )


@dataclass(frozen=True, slots=True)
class AgentProfile:
    agent_id: str
    display_name: str
    host_id: str
    executable_digest: str
    person_ids: tuple[str, ...]
    scopes: tuple[str, ...]
    created_at: str
    revoked_at: str | None = None


class TrustManager:
    SERVICE = "healthCare.agent"

    def __init__(self, vault: VaultStore, secrets_store: SecretStore):
        self.vault = vault
        self.secrets = secrets_store

    def pair_agent(
        self,
        display_name: str,
        host_id: str,
        executable_digest: str,
        person_ids: list[str],
        scopes: list[str],
    ) -> tuple[AgentProfile, str]:
        if not display_name.strip() or not host_id.strip() or not executable_digest.strip():
            raise VaultError("display_name, host_id and executable_digest are required")
        unknown = [person_id for person_id in person_ids if person_id not in self.vault.state["persons"]]
        if unknown:
            raise VaultError(f"unknown person ids: {', '.join(unknown)}")
        allowed = {"observations.read", "documents.read", "analytics.read", "records.write"}
        if set(scopes) - allowed:
            raise VaultError("A1 pairing only permits read scopes plus records.write")
        agent_id = new_id("agent")
        token = secrets.token_urlsafe(32)
        profile = {
            "agent_id": agent_id,
            "display_name": display_name,
            "host_id": host_id,
            "executable_digest": executable_digest,
            "person_ids": sorted(set(person_ids)),
            "scopes": sorted(set(scopes)),
            "created_at": now_iso(),
            "revoked_at": None,
            "token_digest": hashlib.sha256(token.encode("utf-8")).hexdigest(),
        }
        self.vault.state["agents"][agent_id] = profile
        self.secrets.set(self.SERVICE, agent_id, token)
        for person_id in profile["person_ids"]:
            for scope in profile["scopes"]:
                self.vault.issue_consent_grant(agent_id, person_id, scope, "agent management")
        self.vault.append_audit("agent.paired", agent_id, "success", metadata={"host_id": host_id, "scopes": profile["scopes"]})
        return self.profile(agent_id), token

    def profile(self, agent_id: str) -> AgentProfile:
        raw = self.vault.state["agents"].get(agent_id)
        if not raw:
            raise VaultError("unknown agent")
        return AgentProfile(
            agent_id=raw["agent_id"],
            display_name=raw["display_name"],
            host_id=raw["host_id"],
            executable_digest=raw["executable_digest"],
            person_ids=tuple(raw["person_ids"]),
            scopes=tuple(raw["scopes"]),
            created_at=raw["created_at"],
            revoked_at=raw.get("revoked_at"),
        )

    def list_profiles(self) -> list[AgentProfile]:
        return [self.profile(agent_id) for agent_id in sorted(self.vault.state["agents"])]

    def revoke_agent(self, agent_id: str) -> AgentProfile:
        profile = self.profile(agent_id)
        if profile.revoked_at is None:
            self.vault.state["agents"][agent_id]["revoked_at"] = now_iso()
            self.secrets.delete(self.SERVICE, agent_id)
            self.vault.append_audit("agent.revoked", agent_id, "success")
        return self.profile(agent_id)

    @staticmethod
    def _challenge_response(digest_hex: str, nonce: str, agent_id: str, person_id: str, method: str) -> str:
        """Proof = HMAC-SHA256(key=sha256(token), message=nonce:agent:person:method).

        The daemon only stores ``sha256(token)`` (the digest), so the client
        proves possession of the token without it ever crossing the wire, and
        the nonce binds each proof to one request (replay resistance).
        """
        message = f"{nonce}:{agent_id}:{person_id}:{method}".encode("utf-8")
        return hmac.new(digest_hex.encode("ascii"), message, hashlib.sha256).hexdigest()

    def authenticate(
        self,
        agent_id: str,
        token: str,
        host_id: str,
        person_id: str,
        required_scope: str | None,
        nonce: str | None = None,
        proof: str | None = None,
        method: str = "request",
    ) -> AgentProfile:
        """Authenticate an Agent request.

        ``required_scope=None`` performs credential-only authentication for
        capability discovery; callers must still authorize the concrete method.
        When ``nonce``/``proof`` are supplied the credential is verified as a
        challenge-response (replay-resistant); otherwise it falls back to the
        raw-token digest comparison for the ephemeral broker and tests.
        Successful reads are not audited: persisting an audit event would
        rewrite the whole Vault and bump ``data_revision`` on every read.
        Failed authentication is a security event and is persisted.
        """
        try:
            profile = self.profile(agent_id)
            raw = self.vault.state["agents"][agent_id]
            if nonce and proof:
                expected = self._challenge_response(raw["token_digest"], nonce, agent_id, person_id, method)
                credential_ok = hmac.compare_digest(expected, proof)
            else:
                credential_ok = hmac.compare_digest(
                    raw["token_digest"], hashlib.sha256(token.encode("utf-8")).hexdigest()
                )
            valid = (
                profile.revoked_at is None
                and credential_ok
                and hmac.compare_digest(profile.host_id, host_id)
                and person_id in profile.person_ids
                and (required_scope is None or required_scope in profile.scopes)
                and (required_scope is None or self.vault.consent_is_active(agent_id, person_id, required_scope))
            )
            if not valid:
                raise VaultError("agent authentication failed")
            return profile
        except VaultError as exc:
            self.vault.append_audit("agent.authentication_failed", agent_id, "denied", person_id=person_id, metadata={"scope": required_scope})
            raise exc

    def token_from_keychain(self, agent_id: str) -> str:
        token = self.secrets.get(self.SERVICE, agent_id)
        if not token:
            raise VaultError("agent token is not present in the keychain")
        return token
