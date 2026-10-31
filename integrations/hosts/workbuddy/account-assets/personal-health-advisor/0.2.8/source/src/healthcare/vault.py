"""Encrypted local Vault: storage core plus domain mixins.

The VaultStore class is assembled from domain mixins kept beside this
module (``vault_imports``, ``vault_records``, ``vault_care``); the
low-level crypto and locking helpers live in ``vault_support``. All
names are re-exported here so existing
``from healthcare.vault import ...`` callers keep working.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import secrets
import stat
import subprocess
import sys
import shutil
import tempfile
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, IO

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from .models import (
    ActivityRecord,
    ConsentGrant,
    DocumentPage,
    DiagnosisMention,
    Encounter,
    EmotionRecord,
    EvidenceRecord,
    FieldCandidate,
    ImportJob,
    MedicationRecord,
    MedicationPlan,
    Observation,
    PersonProfile,
    ProvenanceRecord,
    ReminderRule,
    ReminderOccurrence,
    SleepRecord,
    SourceDocument,
    VitalMeasurement,
    new_id,
    now_iso,
    serialize,
)
from .object_store import EncryptedObjectStore, ObjectStoreError
from .parser import parse_report, parse_report_date
from .task_mapping import fallback_status_payload

from .vault_support import (
    VaultError,
    VaultConflictError,
    SessionError,
    _await_session_broker_ready,
    _derive_key,
    _canonical,
    _sha256,
    approval_destination_target,
    _secure_mode,
    _exclusive_vault_lock,
)
from .vault_imports import ImportDomainMixin
from .vault_records import RecordDomainMixin
from .vault_care import CareDomainMixin

__all__ = [
    "VaultStore", "VaultError", "VaultConflictError", "SessionError",
    "read_session", "read_encrypted_export", "approval_destination_target",
]


class VaultStore(ImportDomainMixin, RecordDomainMixin, CareDomainMixin):
    VERSION = 1
    MIGRATIONS: dict[int, Any] = {}

    def __init__(self, path: Path, passphrase: str, state: dict[str, Any]):
        self.path = path
        self.passphrase = passphrase
        self.state = state
        self.state.setdefault("pages", {})
        self.state.setdefault("identities", {})
        self.state.setdefault("import_idempotency", {})
        self.state.setdefault("import_requests", {})
        self.state.setdefault("approval_grants", {})
        self.state.setdefault("data_revision", 0)
        self.state.setdefault("object_store_key", base64.b64encode(secrets.token_bytes(32)).decode("ascii"))
        self.state.setdefault("agents", {})
        self.state.setdefault("audit_events", [])
        self.state.setdefault("vitals", {})
        self.state.setdefault("medications", {})
        self.state.setdefault("activities", {})
        self.state.setdefault("emotions", {})
        self.state.setdefault("sleep_records", {})
        self.state.setdefault("csv_imports", {})
        self.state.setdefault("consent_grants", {})
        self.state.setdefault("encounters", {})
        self.state.setdefault("diagnoses", {})
        self.state.setdefault("medication_plans", {})
        self.state.setdefault("reminder_rules", {})
        self.state.setdefault("reminder_occurrences", {})
        self._persisted_revision = int(self.state["data_revision"])
        self._defer_saves = False

    @contextmanager
    def deferred_save(self):
        """Batch many record writes into one encrypted save.

        Every record method appends an audit event, and each audit event saves
        the Vault (one PBKDF2 derivation per save). Bulk builders such as the
        demo Vault use this to write once at the end; the revision check in
        ``save`` still runs for that final write.
        """
        if self._defer_saves:
            yield
            return
        self._defer_saves = True
        try:
            yield
        finally:
            self._defer_saves = False
        self.save()

    @classmethod
    def fresh_state(cls) -> dict[str, Any]:
        """The empty state of a newly created Vault (also used to reset a demo Vault in place)."""
        return {
            "vault_version": cls.VERSION,
            "persons": {},
            "documents": {},
            "pages": {},
            "evidence": {},
            "identities": {},
            "jobs": {},
            "candidates": {},
            "observations": {},
            "provenance": {},
            "agents": {},
            "audit_events": [],
            "import_idempotency": {},
            "import_requests": {},
            "approval_grants": {},
            "data_revision": 0,
            "object_store_key": base64.b64encode(secrets.token_bytes(32)).decode("ascii"),
            "vitals": {},
            "medications": {},
            "activities": {},
            "emotions": {},
            "sleep_records": {},
            "csv_imports": {},
            "encounters": {},
            "diagnoses": {},
            "medication_plans": {},
            "reminder_rules": {},
            "reminder_occurrences": {},
        }

    @classmethod
    def create(cls, path: Path, passphrase: str) -> "VaultStore":
        if path.exists():
            raise VaultError(f"vault already exists: {path}")
        store = cls(path, passphrase, cls.fresh_state())
        store.save()
        return store

    @classmethod
    def open(cls, path: Path, passphrase: str) -> "VaultStore":
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
            salt = base64.b64decode(envelope["salt"])
            nonce = base64.b64decode(envelope["nonce"])
            ciphertext = base64.b64decode(envelope["ciphertext"])
            key = _derive_key(passphrase, salt)
            plaintext = AESGCM(key).decrypt(nonce, ciphertext, b"healthCare-vault-v1")
            state = json.loads(plaintext.decode("utf-8"))
        except (OSError, KeyError, ValueError, json.JSONDecodeError) as exc:
            raise VaultError("unable to open vault") from exc
        except Exception as exc:
            raise VaultError("invalid passphrase or corrupted vault") from exc
        current = int(state.get("vault_version", 0))
        if current > cls.VERSION:
            raise VaultError(f"vault version {current} is newer than supported {cls.VERSION}")
        migrated = False
        while current < cls.VERSION:
            migrator = cls.MIGRATIONS.get(current)
            if migrator is None:
                raise VaultError(f"no migration path from vault version {current}")
            state = migrator(state)
            current += 1
            state["vault_version"] = current
            migrated = True
        store = cls(path, passphrase, state)
        if migrated:
            store.save()
        return store

    def refresh(self) -> None:
        """Re-read the Vault and adopt both its state and its on-disk revision.

        Long-lived holders (the daemon, the session broker) must re-read before
        serving a request. Replacing only ``state`` leaves ``_persisted_revision``
        stale, so every later ``save`` raises ``VaultConflictError`` until the
        process restarts. Refreshing both keeps writes working after any other
        local process (CLI, cron, another agent host) commits.
        """
        fresh = VaultStore.open(self.path, self.passphrase)
        self.state = fresh.state
        self._persisted_revision = fresh._persisted_revision

    def save(self, *, on_disk_passphrase: str | None = None) -> None:
        if self._defer_saves:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_name(f"{self.path.name}.lock")
        with _exclusive_vault_lock(lock_path):
            current_revision = self._on_disk_revision(on_disk_passphrase)
            if current_revision is not None and current_revision != self._persisted_revision:
                raise VaultConflictError(
                    "Vault changed in another local process; reopen it and retry the action"
                )
            next_revision = self._persisted_revision + 1
            self.state["data_revision"] = next_revision
            salt = secrets.token_bytes(16)
            nonce = secrets.token_bytes(12)
            key = _derive_key(self.passphrase, salt)
            ciphertext = AESGCM(key).encrypt(nonce, _canonical(self.state), b"healthCare-vault-v1")
            envelope = {
                "format": "healthCare.encrypted-vault",
                "version": 1,
                "salt": base64.b64encode(salt).decode("ascii"),
                "nonce": base64.b64encode(nonce).decode("ascii"),
                "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
            }
            temporary = self.path.with_name(f".{self.path.name}.{secrets.token_hex(6)}.tmp")
            temporary.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
            _secure_mode(temporary)
            os.replace(temporary, self.path)
            _secure_mode(self.path)
            self._persisted_revision = next_revision

    def _on_disk_revision(self, passphrase: str | None = None) -> int | None:
        """Read only the encrypted revision while holding the writer lock."""
        if not self.path.exists():
            return None
        try:
            envelope = json.loads(self.path.read_text(encoding="utf-8"))
            key = _derive_key(passphrase or self.passphrase, base64.b64decode(envelope["salt"]))
            plaintext = AESGCM(key).decrypt(
                base64.b64decode(envelope["nonce"]),
                base64.b64decode(envelope["ciphertext"]),
                b"healthCare-vault-v1",
            )
            return int(json.loads(plaintext.decode("utf-8")).get("data_revision", 0))
        except Exception as exc:
            raise VaultError("unable to verify the current Vault revision") from exc

    @property
    def object_store(self) -> EncryptedObjectStore:
        try:
            key = base64.b64decode(self.state["object_store_key"])
            return EncryptedObjectStore(self.path.with_name(f"{self.path.name}.objects"), key)
        except (KeyError, ValueError, ObjectStoreError) as exc:
            raise VaultError("invalid object store key") from exc

    def _audit_backfill(self) -> str:
        """Chain any pre-chain audit events and return the current chain head.

        Events written before the chain existed have no hashes; the first
        append after this change backfills them in order so the whole log is
        verifiable.
        """
        previous = "genesis"
        for event in self.state["audit_events"]:
            if event.get("chain_hash"):
                previous = event["chain_hash"]
                continue
            content = {key: value for key, value in event.items() if key not in ("chain_hash", "prev_hash")}
            event["prev_hash"] = previous
            event["chain_hash"] = _sha256(previous.encode("utf-8") + _canonical(content))
            previous = event["chain_hash"]
        return previous

    def append_audit(
        self,
        event: str,
        actor: str,
        outcome: str,
        person_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append a tamper-evident audit event to the hash chain."""
        record = {
            "id": new_id("audit"),
            "event": event,
            "actor": actor,
            "outcome": outcome,
            "person_id": person_id,
            "metadata": metadata or {},
            "created_at": now_iso(),
        }
        previous = self._audit_backfill()
        content = {key: value for key, value in record.items() if key not in ("chain_hash", "prev_hash")}
        record["prev_hash"] = previous
        record["chain_hash"] = _sha256(previous.encode("utf-8") + _canonical(content))
        self.state["audit_events"].append(record)
        self.state["audit_chain_head"] = record["chain_hash"]
        self.save()
        return record

    def verify_audit_chain(self) -> bool:
        """Recompute the audit hash chain and confirm it is unmodified."""
        previous = "genesis"
        for event in self.state["audit_events"]:
            if event.get("prev_hash") != previous or not event.get("chain_hash"):
                return False
            content = {key: value for key, value in event.items() if key not in ("chain_hash", "prev_hash")}
            expected = _sha256(previous.encode("utf-8") + _canonical(content))
            if not hmac.compare_digest(event["chain_hash"], expected):
                return False
            previous = event["chain_hash"]
        return hmac.compare_digest(previous, self.state.get("audit_chain_head", "genesis"))

    def audit_events(self, limit: int = 100) -> list[dict[str, Any]]:
        if limit < 1 or limit > 500:
            raise VaultError("limit must be between 1 and 500")
        return list(reversed(self.state["audit_events"][-limit:]))

    def backup_to(
        self,
        destination: Path,
        backup_passphrase: str,
        *,
        control_session_id: str | None = None,
        approval_grant_id: str | None = None,
        expected_revision: int | None = None,
    ) -> Path:
        """Write an independently encrypted backup of the Vault and source objects."""
        self._require_control_approval(
            control_session_id,
            approval_grant_id,
            expected_revision,
            action="backup.create",
            person_id="vault",
            target_ids=[approval_destination_target(destination)],
        )
        self.save()
        source = self.path.read_bytes()
        objects: dict[str, str] = {}
        object_root = self.object_store.root
        if object_root.exists():
            for object_path in object_root.rglob("*.hobj"):
                if not object_path.is_file() or object_path.is_symlink():
                    raise VaultError("object store contains an unsafe entry")
                relative = object_path.relative_to(object_root)
                objects[str(relative)] = base64.b64encode(object_path.read_bytes()).decode("ascii")
        bundle = {
            "format": "healthCare.backup-bundle",
            "version": 2,
            "vault": base64.b64encode(source).decode("ascii"),
            "objects": objects,
        }
        salt = secrets.token_bytes(16)
        nonce = secrets.token_bytes(12)
        key = _derive_key(backup_passphrase, salt)
        ciphertext = AESGCM(key).encrypt(nonce, _canonical(bundle), b"healthCare-backup-v2")
        envelope = {
            "format": "healthCare.encrypted-backup",
            "version": 2,
            "salt": base64.b64encode(salt).decode("ascii"),
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        }
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{secrets.token_hex(6)}.tmp")
        temporary.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
        _secure_mode(temporary)
        os.replace(temporary, destination)
        _secure_mode(destination)
        self.append_audit(
            "backup.created",
            "control",
            "success",
            metadata={
                "backup": str(destination),
                "control_session_id": control_session_id,
                "approval_grant_id": approval_grant_id,
            },
        )
        return destination

    def rotate_passphrase(
        self,
        new_passphrase: str,
        *,
        control_session_id: str | None = None,
        approval_grant_id: str | None = None,
        expected_revision: int | None = None,
    ) -> None:
        self._require_control_approval(
            control_session_id,
            approval_grant_id,
            expected_revision,
            action="vault.key_rotate",
            person_id="vault",
            target_ids=["vault-key"],
        )
        if not new_passphrase:
            raise VaultError("new passphrase must not be empty")
        self.append_audit(
            "vault.key_rotated",
            "control",
            "success",
            metadata={
                "control_session_id": control_session_id,
                "approval_grant_id": approval_grant_id,
            },
        )
        # First commit the audit event under the existing key. Re-encrypting
        # with the new key then verifies the old on-disk revision explicitly.
        old_passphrase = self.passphrase
        self.passphrase = new_passphrase
        self.save(on_disk_passphrase=old_passphrase)

    def crypto_erase(
        self,
        confirmation: str,
        *,
        control_session_id: str | None = None,
        approval_grant_id: str | None = None,
        expected_revision: int | None = None,
    ) -> Path:
        """Destroy this Vault and its adjacent encrypted object store."""
        self._require_control_approval(
            control_session_id,
            approval_grant_id,
            expected_revision,
            action="vault.crypto_erase",
            person_id="vault",
            target_ids=["vault"],
        )
        if confirmation != "ERASE_VAULT":
            raise VaultError("crypto erase requires confirmation ERASE_VAULT")
        object_root = self.object_store.root
        if object_root.exists():
            if object_root.is_symlink() or not object_root.is_dir():
                raise VaultError("object store path is unsafe")
            shutil.rmtree(object_root)
        try:
            self.path.unlink()
        except FileNotFoundError as exc:
            raise VaultError("Vault does not exist") from exc
        tombstone = self.path.with_name(f"{self.path.name}.tombstone")
        tombstone_payload = {
            "format": "healthCare.vault-tombstone",
            "version": 1,
            "operation": "crypto_erase",
            "created_at": now_iso(),
        }
        temporary = tombstone.with_name(f".{tombstone.name}.{secrets.token_hex(6)}.tmp")
        temporary.write_text(json.dumps(tombstone_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        _secure_mode(temporary)
        os.replace(temporary, tombstone)
        _secure_mode(tombstone)
        return tombstone

    @classmethod
    def restore_from(
        cls,
        backup: Path,
        destination: Path,
        backup_passphrase: str,
        *,
        confirmation: str | None = None,
        replace: bool = False,
    ) -> Path:
        if confirmation != "RESTORE_VAULT":
            raise VaultError("restore requires confirmation RESTORE_VAULT")
        if destination.exists() and not replace:
            raise VaultError(
                "destination vault already exists; restore to a new path or pass replace=True to overwrite it"
            )
        stale_object_root = destination.with_name(f"{destination.name}.objects")
        if replace and stale_object_root.exists():
            if stale_object_root.is_symlink() or not stale_object_root.is_dir():
                raise VaultError("object store path is unsafe")
            shutil.rmtree(stale_object_root)
        try:
            backup_bytes = backup.read_bytes()
            backup_digest = _sha256(backup_bytes)
            envelope = json.loads(backup_bytes.decode("utf-8"))
            if envelope.get("format") != "healthCare.encrypted-backup" or envelope.get("version") not in {1, 2}:
                raise VaultError("unsupported backup format")
            key = _derive_key(backup_passphrase, base64.b64decode(envelope["salt"]))
            aad = b"healthCare-backup-v2" if envelope["version"] == 2 else b"healthCare-backup-v1"
            source = AESGCM(key).decrypt(
                base64.b64decode(envelope["nonce"]),
                base64.b64decode(envelope["ciphertext"]),
                aad,
            )
            if envelope["version"] == 1:
                vault_source = source
                objects: dict[str, str] = {}
            else:
                bundle = json.loads(source.decode("utf-8"))
                if bundle.get("format") != "healthCare.backup-bundle" or bundle.get("version") != 2:
                    raise VaultError("backup does not contain a valid bundle")
                vault_source = base64.b64decode(bundle["vault"])
                objects = bundle.get("objects", {})
                if not isinstance(objects, dict):
                    raise VaultError("backup object manifest is invalid")
            restored = json.loads(vault_source.decode("utf-8"))
            if restored.get("format") != "healthCare.encrypted-vault":
                raise VaultError("backup does not contain a Vault")
        except VaultError:
            raise
        except Exception as exc:
            raise VaultError("invalid backup or backup passphrase") from exc
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{secrets.token_hex(6)}.tmp")
        temporary.write_bytes(vault_source)
        _secure_mode(temporary)
        os.replace(temporary, destination)
        _secure_mode(destination)
        object_root = destination.with_name(f"{destination.name}.objects")
        for relative_name, encoded in objects.items():
            relative = Path(relative_name)
            if relative.is_absolute() or ".." in relative.parts or relative.suffix != ".hobj":
                raise VaultError("backup contains an unsafe object path")
            object_path = object_root / relative
            object_path.parent.mkdir(parents=True, exist_ok=True)
            object_temporary = object_path.with_name(f".{object_path.name}.{secrets.token_hex(6)}.tmp")
            object_temporary.write_bytes(base64.b64decode(encoded))
            _secure_mode(object_temporary)
            os.replace(object_temporary, object_path)
            _secure_mode(object_path)
        receipt = destination.with_name(f"{destination.name}.restore-receipt.json")
        receipt_payload = {
            "format": "healthCare.restore-receipt",
            "version": 1,
            "operation": "restore",
            "backup_sha256": backup_digest,
            "object_count": len(objects),
            "created_at": now_iso(),
        }
        receipt_temporary = receipt.with_name(f".{receipt.name}.{secrets.token_hex(6)}.tmp")
        receipt_temporary.write_text(json.dumps(receipt_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        _secure_mode(receipt_temporary)
        os.replace(receipt_temporary, receipt)
        _secure_mode(receipt)
        return destination

    def ensure_person(self, person_id: str, display_name: str | None = None) -> PersonProfile:
        existing = self.state["persons"].get(person_id)
        if existing:
            return PersonProfile(**existing)
        person = PersonProfile(person_id, display_name or person_id)
        self.state["persons"][person_id] = serialize(person)
        self.save()
        return person

    @staticmethod
    def _iso_date(value: str | None, field_name: str, *, required: bool = False) -> str | None:
        if value is None or not str(value).strip():
            if required:
                raise VaultError(f"{field_name} is required")
            return None
        try:
            return date.fromisoformat(str(value).strip()).isoformat()
        except ValueError as exc:
            raise VaultError(f"{field_name} must be an ISO date") from exc

    @staticmethod
    def _clock_time(value: str | None, field_name: str, *, required: bool = False) -> str | None:
        if value is None or not str(value).strip():
            if required:
                raise VaultError(f"{field_name} is required")
            return None
        try:
            return datetime.strptime(str(value).strip(), "%H:%M").strftime("%H:%M")
        except ValueError as exc:
            raise VaultError(f"{field_name} must use HH:MM local time") from exc

    def _require_person(self, person_id: str) -> None:
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")

    def _require_person_document(self, person_id: str, document_id: str) -> None:
        document = self.state["documents"].get(document_id)
        if not document or document.get("person_id") != person_id:
            raise VaultError("source document is not assigned to this person")

    def trend_summary(
        self, person_id: str, source: str, field: str, start: str | None = None, end: str | None = None,
    ) -> dict[str, Any]:
        self._require_person(person_id)
        start_date = self._iso_date(start, "start")
        end_date = self._iso_date(end, "end")
        if start_date and end_date and end_date < start_date:
            raise VaultError("end cannot be before start")
        from .trends import observation_trend, vital_trend

        if source == "observation":
            return observation_trend(self.observations(person_id, field), field, start_date, end_date)
        if source == "vital":
            try:
                return vital_trend(self.vitals(person_id, limit=5000), field, start_date, end_date)
            except ValueError as exc:
                raise VaultError(str(exc)) from exc
        raise VaultError("source must be observation or vital")

    def visit_summary(self, person_id: str, start: str | None = None, end: str | None = None) -> dict[str, Any]:
        self._require_person(person_id)
        start_date = self._iso_date(start, "start")
        end_date = self._iso_date(end, "end")
        if start_date and end_date and end_date < start_date:
            raise VaultError("end cannot be before start")
        from .summaries import build_visit_summary

        return build_visit_summary(self, person_id, start_date, end_date)

    def vitals(self, person_id: str, limit: int = 500) -> list[dict[str, Any]]:
        if limit < 1 or limit > 5000:
            raise VaultError("limit must be between 1 and 5000")
        items = [v for v in self.state["vitals"].values() if v.get("person_id") == person_id]
        return sorted(items, key=lambda v: (v["measured_at"], v["created_at"]))[-limit:]

    def medications(self, person_id: str, limit: int = 500) -> list[dict[str, Any]]:
        if limit < 1 or limit > 5000:
            raise VaultError("limit must be between 1 and 5000")
        items = [v for v in self.state["medications"].values() if v.get("person_id") == person_id]
        return sorted(items, key=lambda v: (v["taken_at"], v["created_at"]))[-limit:]

    def activities(self, person_id: str, limit: int = 500) -> list[dict[str, Any]]:
        if limit < 1 or limit > 5000:
            raise VaultError("limit must be between 1 and 5000")
        items = [v for v in self.state["activities"].values() if v.get("person_id") == person_id]
        return sorted(items, key=lambda v: (v["date"], v["created_at"]))[-limit:]

    def emotions(self, person_id: str, limit: int = 500) -> list[dict[str, Any]]:
        if limit < 1 or limit > 5000:
            raise VaultError("limit must be between 1 and 5000")
        items = [v for v in self.state["emotions"].values() if v.get("person_id") == person_id]
        return sorted(items, key=lambda v: (v["occurred_at"], v["created_at"]))[-limit:]

    def sleep_records(self, person_id: str, limit: int = 500) -> list[dict[str, Any]]:
        if limit < 1 or limit > 5000:
            raise VaultError("limit must be between 1 and 5000")
        items = [v for v in self.state["sleep_records"].values() if v.get("person_id") == person_id]
        return sorted(items, key=lambda v: (v["date"], v["created_at"]))[-limit:]

    def recent(self, person_id: str, days: int = 7) -> dict[str, Any]:
        """Daily vitals, medications, activities, emotions and sleep from recent days.

        Record timestamps are local wall-clock strings ("YYYY-MM-DD[THH:MM]"),
        so the window compares local dates lexicographically. Intended for
        post-record verification: `recent(person, days=1)` answers "did today's
        entry land?" without a plaintext export.
        """
        if days < 1 or days > 366:
            raise VaultError("days must be between 1 and 366")
        cutoff = (datetime.now().date() - timedelta(days=days - 1)).isoformat()

        def within(timestamp: str | None) -> bool:
            return bool(timestamp) and timestamp[:10] >= cutoff

        return {
            "since": cutoff,
            "days": days,
            "vitals": [v for v in self.vitals(person_id, limit=5000) if within(v.get("measured_at"))],
            "medications": [m for m in self.medications(person_id, limit=5000) if within(m.get("taken_at"))],
            "activities": [a for a in self.activities(person_id, limit=5000) if within(a.get("date"))],
            "emotions": [e for e in self.emotions(person_id, limit=5000) if within(e.get("occurred_at"))],
            "sleep_records": [s for s in self.sleep_records(person_id, limit=5000) if within(s.get("date"))],
        }

    def register_approval(self, grant: dict[str, Any]) -> None:
        """Record a single-use Control approval grant inside the Vault state.

        The record persists with the next save; ``_require_control_approval``
        only accepts operations backed by a registered, unconsumed grant whose
        action, person, targets and revision all match.
        """
        self.state["approval_grants"][grant["grant_id"]] = {
            "session_id": grant["session_id"],
            "action": grant["action"],
            "person_id": grant["person_id"],
            "target_ids": list(grant["target_ids"]),
            "expected_revision": int(grant["expected_revision"]),
            "expires_at": grant["expires_at"],
            "consumed": False,
        }

    def _require_control_approval(
        self,
        control_session_id: str | None,
        approval_grant_id: str | None,
        expected_revision: int | None,
        *,
        action: str | None = None,
        person_id: str | None = None,
        target_ids: list[str] | None = None,
    ) -> None:
        if not control_session_id or not approval_grant_id or expected_revision is None:
            raise VaultError("trusted Control approval required")
        record = self.state["approval_grants"].get(approval_grant_id)
        if (
            not record
            or record.get("consumed")
            or record.get("session_id") != control_session_id
            or int(record.get("expected_revision", -1)) != int(expected_revision)
        ):
            raise VaultError("trusted Control approval required")
        if int(expected_revision) != int(self.state.get("data_revision", 0)):
            raise VaultError("CONFLICT_REVISION: approval target changed")
        if action is not None and record.get("action") != action:
            raise VaultError("approval grant does not match the requested action")
        if person_id is not None and record.get("person_id") != person_id:
            raise VaultError("approval grant does not match the requested person")
        if target_ids is not None and [str(item) for item in record.get("target_ids", [])] != sorted(set(target_ids)):
            raise VaultError("approval grant does not match the requested targets")
        try:
            expires = datetime.fromisoformat(str(record.get("expires_at")))
        except ValueError as exc:
            raise VaultError("approval grant has an invalid expiry") from exc
        if expires <= datetime.now(timezone.utc):
            raise VaultError("approval grant expired")
        record["consumed"] = True

    def observations(self, person_id: str, field: str | None = None) -> list[dict[str, Any]]:
        values = [item for item in self.state["observations"].values() if item["person_id"] == person_id]
        if field:
            values = [item for item in values if item["field"] == field]
        return sorted(values, key=lambda item: (item["measured_at"], item["created_at"]))

    def evidence_for(self, person_id: str, observation_id: str) -> dict[str, Any]:
        observation = self.state["observations"].get(observation_id)
        if not observation or observation["person_id"] != person_id:
            raise VaultError("observation not found")
        evidence = self.state["evidence"].get(observation["evidence_id"])
        document = self.state["documents"].get(observation["document_id"])
        if not evidence or not document:
            raise VaultError("evidence chain is incomplete")
        return {"observation": observation, "evidence": evidence, "document": {
            "id": document["id"],
            "filename": document["filename"],
            "sha256": document["sha256"],
            "report_date": document["report_date"],
            "identity_status": document.get("identity_status"),
            "revision": document.get("revision", 1),
            "media_type": document.get("media_type", "text/plain"),
            "decoder": document.get("decoder"),
            "object_id": document.get("object_id"),
        }}

    def source_evidence_for(self, person_id: str, document_id: str, evidence_id: str) -> dict[str, Any]:
        for observation in self.observations(person_id):
            if observation.get("document_id") == document_id and observation.get("evidence_id") == evidence_id:
                return self.evidence_for(person_id, observation["id"])
        raise VaultError("source evidence not found")

    def export_confirmed(
        self,
        person_id: str,
        destination: Path,
        export_passphrase: str | None = None,
        plaintext: bool = False,
        confirm_plaintext: bool = False,
        *,
        control_session_id: str | None = None,
        approval_grant_id: str | None = None,
        expected_revision: int | None = None,
    ) -> Path:
        """Export confirmed facts without exposing the Vault itself."""
        self._require_control_approval(
            control_session_id,
            approval_grant_id,
            expected_revision,
            action="records.export",
            person_id=person_id,
            target_ids=[approval_destination_target(destination)],
        )
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        if plaintext and not confirm_plaintext:
            raise VaultError("plaintext export requires explicit Control confirmation")
        if not plaintext and not export_passphrase:
            raise VaultError("encrypted export requires an export passphrase")
        items = [self.evidence_for(person_id, observation["id"]) for observation in self.observations(person_id)]
        payload = {
            "format": "healthCare.confirmed-export",
            "version": 1,
            "person_id": person_id,
            "data_revision": int(self.state.get("data_revision", 0)),
            "items": items,
        }
        if plaintext:
            output = {
                "format": "healthCare.plaintext-export",
                "version": 1,
                "payload": payload,
            }
        else:
            salt = secrets.token_bytes(16)
            nonce = secrets.token_bytes(12)
            key = _derive_key(export_passphrase or "", salt)
            ciphertext = AESGCM(key).encrypt(nonce, _canonical(payload), b"healthCare-export-v1")
            output = {
                "format": "healthCare.encrypted-export",
                "version": 1,
                "salt": base64.b64encode(salt).decode("ascii"),
                "nonce": base64.b64encode(nonce).decode("ascii"),
                "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
            }
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{secrets.token_hex(6)}.tmp")
        temporary.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        _secure_mode(temporary)
        os.replace(temporary, destination)
        _secure_mode(destination)
        self.append_audit(
            "export.created",
            "control",
            "success",
            person_id=person_id,
            metadata={
                "format": output["format"],
                "encrypted": not plaintext,
                "control_session_id": control_session_id,
                "approval_grant_id": approval_grant_id,
            },
        )
        return destination

    def search(self, person_id: str, query: str = "") -> list[dict[str, Any]]:
        lowered = query.casefold().strip()
        values = self.observations(person_id)
        if not lowered:
            return values
        return [item for item in values if lowered in item["field"].casefold() or lowered in str(item["value"]).casefold()]

    def issue_session(
        self,
        output: Path,
        person_id: str,
        host_id: str,
        scopes: list[str],
        ttl_seconds: int = 600,
        expected_peer_exec_digest: str | None = None,
    ) -> Path:
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        if ttl_seconds < 30 or ttl_seconds > 3600:
            raise VaultError("ttl_seconds must be between 30 and 3600")
        session_id = new_id("session")
        token = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)).replace(microsecond=0).isoformat()
        session_stem = secrets.token_hex(10)
        socket_path = Path("/tmp") / f"healthcare-session-{session_stem}.sock"
        ready_path = Path("/tmp") / f"healthcare-session-{session_stem}.ready"
        session = {
            "format": "healthCare.session-capability",
            "version": 2,
            "session_id": session_id,
            "token": token,
            "socket_path": str(socket_path),
            "person_id": person_id,
            "host_id": host_id,
            "scopes": sorted(set(scopes)),
            "issued_at": now_iso(),
            "expires_at": expires_at,
            "expected_peer_exec_digest": expected_peer_exec_digest,
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output = output.resolve()
        session["session_file"] = str(output)
        # Create with O_EXCL-style 0600 from the start: the file holds the
        # session token and a chmod-after-write leaves a readable window.
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(session, ensure_ascii=False, indent=2))
        env = os.environ.copy()
        source_root = Path(__file__).resolve().parent.parent
        if source_root.name == "src":
            # Source checkout: make the package importable for the child.
            # An installed environment resolves the package on its own.
            env["PYTHONPATH"] = os.pathsep.join(filter(None, (str(source_root), env.get("PYTHONPATH", ""))))
        bootstrap = {
            "vault_path": str(self.path.resolve()),
            "vault_passphrase": self.passphrase,
            "session_id": session_id,
            "token": token,
            "socket_path": str(socket_path),
            "ready_file": str(ready_path),
            "session_file": str(output),
            "person_id": person_id,
            "host_id": host_id,
            "scopes": sorted(set(scopes)),
            "expires_at": expires_at,
            "expected_peer_exec_digest": expected_peer_exec_digest,
        }
        diagnostics = tempfile.TemporaryFile()
        try:
            broker = subprocess.Popen(
                [sys.executable, "-m", "healthcare.session_broker", "--bootstrap-stdin"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=diagnostics,
                close_fds=True,
                start_new_session=True,
                env=env,
            )
            assert broker.stdin is not None
            broker.stdin.write(json.dumps(bootstrap, ensure_ascii=False).encode("utf-8"))
            broker.stdin.close()
        except (OSError, AssertionError) as exc:
            diagnostics.close()
            try:
                output.unlink()
            except OSError:
                pass
            raise SessionError("unable to start ephemeral session broker") from exc
        try:
            if hasattr(broker, "poll"):
                _await_session_broker_ready(broker, ready_path, diagnostics, output)
        finally:
            diagnostics.close()
        return output


def read_session(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SessionError("invalid session file") from exc
    try:
        path.unlink()
    except OSError as exc:
        raise SessionError("session file must be deleted after consumption") from exc
    if payload.get("format") != "healthCare.session-capability" or payload.get("version") != 2:
        raise SessionError("unsupported session capability")
    try:
        expires = datetime.fromisoformat(payload["expires_at"])
    except (KeyError, ValueError) as exc:
        raise SessionError("invalid session expiry") from exc
    if expires <= datetime.now(timezone.utc):
        raise SessionError("session capability expired")
    required = ("session_id", "token", "socket_path", "person_id", "host_id", "scopes", "session_file")
    if any(not payload.get(key) for key in required):
        raise SessionError("incomplete session capability")
    return payload


def read_encrypted_export(path: Path, passphrase: str) -> dict[str, Any]:
    try:
        envelope = json.loads(path.read_text(encoding="utf-8"))
        if envelope.get("format") != "healthCare.encrypted-export" or envelope.get("version") != 1:
            raise VaultError("unsupported export format")
        key = _derive_key(passphrase, base64.b64decode(envelope["salt"]))
        plaintext = AESGCM(key).decrypt(
            base64.b64decode(envelope["nonce"]),
            base64.b64decode(envelope["ciphertext"]),
            b"healthCare-export-v1",
        )
        payload = json.loads(plaintext.decode("utf-8"))
        if payload.get("format") != "healthCare.confirmed-export":
            raise VaultError("export does not contain confirmed data")
        return payload
    except VaultError:
        raise
    except Exception as exc:
        raise VaultError("invalid export or export passphrase") from exc
