from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from .models import new_id, now_iso
from .vault import VaultError, VaultStore, approval_destination_target


def _canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


@dataclass(frozen=True, slots=True)
class ApprovalGrant:
    grant_id: str
    session_id: str
    action: str
    person_id: str
    target_ids: tuple[str, ...]
    expected_revision: int
    purpose: str
    issued_at: str
    expires_at: str
    signature: str


class ControlSession:
    """In-memory trusted local approval context for high-risk Control actions."""

    def __init__(self, vault: VaultStore, actor: str = "control", ttl_seconds: int = 600):
        if ttl_seconds < 30 or ttl_seconds > 3600:
            raise VaultError("control session ttl must be between 30 and 3600")
        self.vault = vault
        self.actor = actor
        self.session_id = new_id("control_session")
        self._secret = secrets.token_bytes(32)
        self._expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
        self._grants: dict[str, ApprovalGrant] = {}

    def _ensure_live(self) -> None:
        if datetime.now(timezone.utc) >= self._expires_at:
            raise VaultError("Control session expired")

    def issue_grant(
        self,
        action: str,
        person_id: str,
        target_ids: Iterable[str],
        purpose: str,
        expected_revision: int | None = None,
    ) -> ApprovalGrant:
        self._ensure_live()
        if not action.strip() or not purpose.strip():
            raise VaultError("approval action and purpose are required")
        targets = tuple(sorted(set(str(target) for target in target_ids)))
        if not targets:
            raise VaultError("approval requires at least one target")
        revision = int(self.vault.state.get("data_revision", 0) if expected_revision is None else expected_revision)
        issued_at = now_iso()
        expires_at = self._expires_at.replace(microsecond=0).isoformat()
        payload = {
            "session_id": self.session_id,
            "action": action,
            "person_id": person_id,
            "target_ids": targets,
            "expected_revision": revision,
            "purpose": purpose.strip()[:300],
            "issued_at": issued_at,
            "expires_at": expires_at,
        }
        signature = hmac.new(self._secret, _canonical(payload), hashlib.sha256).hexdigest()
        grant = ApprovalGrant(
            grant_id=new_id("approval"),
            signature=signature,
            **payload,
        )
        self._grants[grant.grant_id] = grant
        return grant

    def _consume(
        self,
        grant: ApprovalGrant,
        action: str,
        person_id: str,
        target_ids: Iterable[str],
    ) -> None:
        self._ensure_live()
        stored = self._grants.get(grant.grant_id)
        if stored != grant:
            raise VaultError("approval grant is unknown or already consumed")
        if grant.action != action or grant.person_id != person_id or grant.target_ids != tuple(sorted(set(target_ids))):
            raise VaultError("approval grant does not match the requested action")
        if grant.expected_revision != int(self.vault.state.get("data_revision", 0)):
            raise VaultError("CONFLICT_REVISION: approval target changed")
        self._grants.pop(grant.grant_id, None)

    def assign_document(self, document_id: str, person_id: str) -> object:
        grant = self.issue_grant(
            "identity.confirm",
            person_id,
            [document_id],
            "confirm document patient assignment",
        )
        self.vault.register_approval(asdict(grant))
        self._consume(grant, "identity.confirm", person_id, [document_id])
        return self.vault.assign_document(
            document_id,
            person_id,
            actor=self.actor,
            control_session_id=self.session_id,
            approval_grant_id=grant.grant_id,
            expected_revision=grant.expected_revision,
        )

    def update_record(self, person_id: str, record_type: str, record_id: str, changes: dict) -> bool:
        if record_type != "observation":
            return self.vault.update_record(person_id, record_type, record_id, changes)
        grant = self.issue_grant("observation.correct", person_id, [record_id], "correct a confirmed observation")
        self.vault.register_approval(asdict(grant))
        self._consume(grant, "observation.correct", person_id, [record_id])
        return self.vault.update_record(
            person_id, record_type, record_id, changes,
            control_session_id=self.session_id, approval_grant_id=grant.grant_id,
            expected_revision=grant.expected_revision,
        )

    def delete_record(self, person_id: str, record_type: str, record_id: str) -> dict | None:
        """Delete one record behind a single-use approval grant; audit keeps the snapshot."""
        grant = self.issue_grant("record.delete", person_id, [record_id], "delete one health record")
        self.vault.register_approval(asdict(grant))
        self._consume(grant, "record.delete", person_id, [record_id])
        return self.vault.delete_record(
            person_id, record_type, record_id,
            control_session_id=self.session_id, approval_grant_id=grant.grant_id,
            expected_revision=grant.expected_revision,
        )

    def review_job(
        self,
        job_id: str,
        accept_all: bool = False,
        field: str | None = None,
        value: float | None = None,
        unit: str | None = None,
    ) -> object:
        raw_job = self.vault.state["jobs"].get(job_id)
        if not raw_job:
            raise VaultError(f"unknown job: {job_id}")
        selected = [
            candidate_id
            for candidate_id in raw_job["candidate_ids"]
            if field is None or self.vault.state["candidates"][candidate_id]["field"] == field
        ]
        if not selected:
            raise VaultError("no matching candidate")
        person_id = raw_job.get("person_id")
        if not person_id:
            raise VaultError("patient identity must be confirmed before review")
        document = self.vault.state["documents"].get(raw_job["document_id"])
        if not document or not document.get("report_date"):
            raise VaultError("report date must be confirmed before review")
        grant = self.issue_grant(
            "extraction.review",
            person_id,
            selected,
            "confirm extraction candidates in trusted local Control",
        )
        self.vault.register_approval(asdict(grant))
        self._consume(grant, "extraction.review", person_id, selected)
        return self.vault.review_job(
            job_id,
            accept_all,
            field,
            value,
            unit,
            control_session_id=self.session_id,
            approval_grant_id=grant.grant_id,
            expected_revision=grant.expected_revision,
        )

    def export_confirmed(
        self,
        person_id: str,
        destination: Path,
        export_passphrase: str | None = None,
        plaintext: bool = False,
        confirm_plaintext: bool = False,
    ) -> object:
        target = approval_destination_target(destination)
        grant = self.issue_grant(
            "records.export",
            person_id,
            [target],
            "export confirmed Health Vault records",
        )
        self.vault.register_approval(asdict(grant))
        self._consume(grant, "records.export", person_id, [target])
        return self.vault.export_confirmed(
            person_id,
            destination,
            export_passphrase=export_passphrase,
            plaintext=plaintext,
            confirm_plaintext=confirm_plaintext,
            control_session_id=self.session_id,
            approval_grant_id=grant.grant_id,
            expected_revision=grant.expected_revision,
        )

    def backup_to(self, destination: Path, backup_passphrase: str) -> Path:
        target = approval_destination_target(destination)
        grant = self.issue_grant("backup.create", "vault", [target], "create encrypted Vault backup")
        self.vault.register_approval(asdict(grant))
        self._consume(grant, "backup.create", "vault", [target])
        return self.vault.backup_to(
            destination,
            backup_passphrase,
            control_session_id=self.session_id,
            approval_grant_id=grant.grant_id,
            expected_revision=grant.expected_revision,
        )

    def rotate_passphrase(self, new_passphrase: str) -> None:
        grant = self.issue_grant("vault.key_rotate", "vault", ["vault-key"], "rotate Vault encryption key")
        self.vault.register_approval(asdict(grant))
        self._consume(grant, "vault.key_rotate", "vault", ["vault-key"])
        self.vault.rotate_passphrase(
            new_passphrase,
            control_session_id=self.session_id,
            approval_grant_id=grant.grant_id,
            expected_revision=grant.expected_revision,
        )

    def crypto_erase(self, confirmation: str) -> Path:
        grant = self.issue_grant("vault.crypto_erase", "vault", ["vault"], "irreversibly erase Vault")
        self.vault.register_approval(asdict(grant))
        self._consume(grant, "vault.crypto_erase", "vault", ["vault"])
        return self.vault.crypto_erase(
            confirmation,
            control_session_id=self.session_id,
            approval_grant_id=grant.grant_id,
            expected_revision=grant.expected_revision,
        )
