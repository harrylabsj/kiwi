from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import socket
import socketserver
import stat
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .trust import TrustManager
from .vault import VaultConflictError, VaultError


def _opt_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _opt_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _opt_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


class LocalHealthDaemon:
    """Authenticated newline-delimited local IPC for Phase 1A1 read requests."""

    _NONCE_TTL = 300.0

    # IPC method -> (required scope, handler name). health_get_capabilities
    # authenticates without a scope check (None); every other method requires
    # the scope listed here. Handlers share the signature
    # (params, agent_id, person_id, profile) -> JSON-serializable dict.
    _HANDLERS: dict[str, tuple[str | None, str]] = {
        "health_ping": ("observations.read", "_handle_ping"),
        "health_get_capabilities": (None, "_handle_capabilities"),
        "health_search_records": ("observations.read", "_handle_search_records"),
        "health_get_timeline": ("observations.read", "_handle_get_timeline"),
        "health_get_observation_series": ("observations.read", "_handle_get_observation_series"),
        "health_get_source_evidence": ("observations.read", "_handle_get_source_evidence"),
        "health_get_source_evidence_ref": ("observations.read", "_handle_get_source_evidence_ref"),
        "health_get_vitals": ("observations.read", "_handle_get_vitals"),
        "health_get_medications": ("observations.read", "_handle_get_medications"),
        "health_get_activities": ("observations.read", "_handle_get_activities"),
        "health_get_emotions": ("observations.read", "_handle_get_emotions"),
        "health_get_sleep_records": ("observations.read", "_handle_get_sleep_records"),
        "health_get_encounters": ("observations.read", "_handle_get_encounters"),
        "health_get_diagnosis_mentions": ("observations.read", "_handle_get_diagnosis_mentions"),
        "health_get_medication_plans": ("observations.read", "_handle_get_medication_plans"),
        "health_get_reminder_rules": ("observations.read", "_handle_get_reminder_rules"),
        "health_get_trend_summary": ("observations.read", "_handle_get_trend_summary"),
        "health_prepare_visit_summary": ("observations.read", "_handle_prepare_visit_summary"),
        "health_record_vital": ("records.write", "_handle_record_vital"),
        "health_record_medication": ("records.write", "_handle_record_medication"),
        "health_update_record": ("records.write", "_handle_update_record"),
        "health_delete_record": ("records.write", "_handle_delete_record"),
        "health_update_medication": ("records.write", "_handle_update_medication"),
        "health_record_activity": ("records.write", "_handle_record_activity"),
        "health_record_emotion": ("records.write", "_handle_record_emotion"),
        "health_record_sleep": ("records.write", "_handle_record_sleep"),
        "health_update_activity_note": ("records.write", "_handle_update_activity_note"),
        "health_request_document_import": ("documents.ingest", "_handle_request_document_import"),
        "health_get_import_status": ("documents.ingest", "_handle_get_import_status"),
    }

    def __init__(self, socket_path: Path, trust: TrustManager):
        self.socket_path = socket_path
        self.trust = trust
        # Handler threads share this daemon; serializing dispatch prevents
        # concurrent VaultStore.open calls from dropping each other's writes.
        self._dispatch_lock = threading.Lock()
        # Nonces seen recently, to reject challenge-response replay.
        self._seen_nonces: dict[str, float] = {}

    def _make_server(self) -> socketserver.ThreadingUnixStreamServer:
        if len(os.fsencode(self.socket_path)) >= 100:
            raise VaultError("Unix socket path is too long; use a short path under /tmp")
        if self.socket_path.exists():
            mode = self.socket_path.stat().st_mode
            if not stat.S_ISSOCK(mode):
                raise VaultError("refusing to replace a non-socket path")
            self.socket_path.unlink()
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        daemon = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                line = self.rfile.readline(1024 * 1024)
                if not line:
                    return
                try:
                    request = json.loads(line.decode("utf-8"))
                    result = daemon.dispatch(request)
                    response = {"id": request.get("id"), "ok": True, "result": result}
                except Exception as exc:  # the IPC boundary must return JSON, never tracebacks
                    response = {"id": request.get("id") if isinstance(locals().get("request"), dict) else None, "ok": False, "error": str(exc)}
                self.wfile.write((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))

        class Server(socketserver.ThreadingUnixStreamServer):
            daemon_threads = True
            allow_reuse_address = False

        server = Server(str(self.socket_path), Handler)
        os.chmod(self.socket_path, stat.S_IRUSR | stat.S_IWUSR)
        return server

    def _close_server(self, server: socketserver.ThreadingUnixStreamServer) -> None:
        server.server_close()
        if self.socket_path.exists() and stat.S_ISSOCK(self.socket_path.stat().st_mode):
            self.socket_path.unlink()

    def serve_once(self) -> None:
        server = self._make_server()
        try:
            server.handle_request()
        finally:
            self._close_server(server)

    def serve_forever(self) -> None:
        server = self._make_server()
        try:
            server.serve_forever()
        finally:
            self._close_server(server)

    def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        with self._dispatch_lock:
            try:
                return self._dispatch_locked(request)
            except VaultConflictError:
                # Another local process committed between our Vault refresh and
                # our save. Each save checks the on-disk revision under the
                # writer lock before writing, so the failed attempt persisted
                # nothing; replay the same request once on freshly read state.
                return self._dispatch_locked(request, replay=True)

    def _dispatch_locked(self, request: dict[str, Any], *, replay: bool = False) -> dict[str, Any]:
        required = ("id", "agent_id", "host_id", "person_id", "method")
        if any(key not in request for key in required):
            raise VaultError("missing IPC request field")
        # Re-read the Vault (state *and* its on-disk revision) before serving:
        # a long-lived process that only replaced the state would keep failing
        # every write after any other local writer committed.
        self.trust.vault.refresh()
        agent_id = str(request["agent_id"])
        person_id = str(request["person_id"])
        method = request["method"]
        nonce = str(request.get("nonce", ""))
        proof = str(request.get("proof", ""))
        if nonce and not replay:
            self._reject_replayed_nonce(nonce)
        try:
            scope, handler_name = self._HANDLERS[method]
        except KeyError:
            raise VaultError("unknown IPC method") from None
        profile = self.trust.authenticate(
            agent_id, str(request.get("token", "")), str(request["host_id"]), person_id,
            scope,
            nonce=nonce or None,
            proof=proof or None,
            method=method,
        )
        params = request.get("params") or {}
        handler: Callable[..., dict[str, Any]] = getattr(self, handler_name)
        return handler(params, agent_id=agent_id, person_id=person_id, profile=profile)

    # ---- read handlers -----------------------------------------------------

    def _handle_ping(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"status": "ok", "person_id": person_id}

    def _handle_capabilities(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"person_id": person_id, "person_ids": sorted(profile.person_ids), "scopes": sorted(profile.scopes)}

    def _handle_search_records(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"items": self.trust.vault.search(person_id, str(params.get("query", ""))), "person_id": person_id}

    def _handle_get_timeline(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        limit = int(params.get("limit", 50))
        if limit < 1 or limit > 200:
            raise VaultError("limit must be between 1 and 200")
        return {"items": self.trust.vault.observations(person_id)[-limit:], "person_id": person_id}

    def _handle_get_observation_series(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        field = str(params.get("field", ""))
        if not field.strip():
            raise VaultError("field must not be empty")
        return {"items": self.trust.vault.observations(person_id, field), "person_id": person_id, "field": field}

    def _handle_get_source_evidence(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return self.trust.vault.evidence_for(person_id, str(params["observation_id"]))

    def _handle_get_source_evidence_ref(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return self.trust.vault.source_evidence_for(
            person_id,
            str(params["document_id"]),
            str(params["evidence_id"]),
        )

    def _handle_get_vitals(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"items": self.trust.vault.vitals(person_id, int(params.get("limit", 5000))), "person_id": person_id}

    def _handle_get_medications(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"items": self.trust.vault.medications(person_id, int(params.get("limit", 5000))), "person_id": person_id}

    def _handle_get_activities(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"items": self.trust.vault.activities(person_id, int(params.get("limit", 5000))), "person_id": person_id}

    def _handle_get_emotions(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"items": self.trust.vault.emotions(person_id, int(params.get("limit", 5000))), "person_id": person_id}

    def _handle_get_sleep_records(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"items": self.trust.vault.sleep_records(person_id, int(params.get("limit", 5000))), "person_id": person_id}

    def _handle_get_encounters(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"items": self.trust.vault.encounters(person_id, int(params.get("limit", 500))), "person_id": person_id}

    def _handle_get_diagnosis_mentions(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"items": self.trust.vault.diagnoses(person_id, int(params.get("limit", 500))), "person_id": person_id}

    def _handle_get_medication_plans(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {"items": self.trust.vault.medication_plans(person_id, int(params.get("limit", 500))), "person_id": person_id}

    def _handle_get_reminder_rules(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return {
            "items": self.trust.vault.reminder_rules(person_id, bool(params.get("include_paused", False))),
            "person_id": person_id,
        }

    def _handle_get_trend_summary(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        source = str(params.get("source", "")).strip()
        field = str(params.get("field", "")).strip()
        if not source or not field:
            raise VaultError("source and field are required")
        return self.trust.vault.trend_summary(
            person_id, source, field, _opt_str(params.get("start")), _opt_str(params.get("end")),
        )

    def _handle_prepare_visit_summary(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return self.trust.vault.visit_summary(
            person_id, _opt_str(params.get("start")), _opt_str(params.get("end")),
        )

    # ---- write handlers ----------------------------------------------------

    def _handle_record_vital(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        measured_at = str(params.get("measured_at", "")).strip()
        if not measured_at:
            raise VaultError("measured_at is required")
        added = self.trust.vault.record_vital(
            person_id,
            measured_at,
            _opt_int(params.get("systolic_mmHg")),
            _opt_int(params.get("diastolic_mmHg")),
            _opt_int(params.get("heart_rate_bpm")),
            weight_kg=_opt_float(params.get("weight_kg")),
            note=_opt_str(params.get("note")),
            source=_opt_str(params.get("source")),
        )
        self.trust.vault.append_audit("agent.record_vital", agent_id, "success", person_id=person_id)
        self.trust.vault.save()
        return {"status": "recorded" if added else "duplicate", "type": "vital", "person_id": person_id}

    def _handle_record_medication(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        taken_at = str(params.get("taken_at", "")).strip()
        medication = str(params.get("medication", "")).strip()
        if not taken_at or not medication:
            raise VaultError("taken_at and medication are required")
        added = self.trust.vault.record_medication(
            person_id,
            taken_at,
            medication,
            dose=_opt_str(params.get("dose")),
            unit=_opt_str(params.get("unit")),
            taken=bool(params.get("taken", True)),
            note=_opt_str(params.get("note")),
            medication_plan_id=_opt_str(params.get("medication_plan_id")),
        )
        self.trust.vault.append_audit("agent.record_medication", agent_id, "success", person_id=person_id)
        self.trust.vault.save()
        return {"status": "recorded" if added else "duplicate", "type": "medication", "person_id": person_id}

    def _handle_update_record(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        record_type = params.get("record_type")
        if not isinstance(record_type, str) or record_type not in {"vital", "medication", "activity", "emotion", "sleep"}:
            raise VaultError("daily record type required; observation corrections require local Control")
        record_id = params.get("record_id")
        if not isinstance(record_id, str) or not record_id.strip():
            raise VaultError("record_id is required")
        if not self.trust.vault.update_record(person_id, record_type, record_id, params.get("changes")):
            raise VaultError("record not found for this person")
        self.trust.vault.append_audit("agent.update_record", agent_id, "success", person_id=person_id)
        self.trust.vault.save()
        return {"status": "updated", "type": record_type, "record_id": record_id, "person_id": person_id}

    def _handle_delete_record(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        record_type = params.get("record_type")
        if not isinstance(record_type, str) or record_type not in {"vital", "medication", "activity", "emotion", "sleep"}:
            raise VaultError("daily record type required; observation deletion requires local Control")
        record_id = params.get("record_id")
        if not isinstance(record_id, str) or not record_id.strip():
            raise VaultError("record_id is required")
        reason = params.get("reason")
        removed = self.trust.vault.delete_record(person_id, record_type, record_id)
        if removed is None:
            raise VaultError("record not found for this person")
        self.trust.vault.append_audit(
            "agent.delete_record", agent_id, "success", person_id=person_id,
            metadata={"record_type": record_type, "record_id": record_id,
                      "reason": str(reason)[:300] if reason else None},
        )
        self.trust.vault.save()
        return {"status": "deleted", "type": record_type, "record_id": record_id, "person_id": person_id}

    def _handle_update_medication(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        medication_id = str(params.get("medication_id", "")).strip()
        changes = params.get("changes")
        if not medication_id or not isinstance(changes, dict):
            raise VaultError("medication_id and changes are required")
        updated = self.trust.vault.update_medication(person_id, medication_id, changes)
        if not updated:
            raise VaultError("medication record not found for this person")
        self.trust.vault.append_audit("agent.update_medication", agent_id, "success", person_id=person_id)
        self.trust.vault.save()
        return {"status": "updated", "type": "medication", "medication_id": medication_id, "person_id": person_id}

    def _handle_record_activity(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        date = str(params.get("date", "")).strip()
        activity_type = str(params.get("activity_type", "")).strip()
        if not date or not activity_type:
            raise VaultError("date and activity_type are required")
        added = self.trust.vault.record_activity(
            person_id,
            date,
            activity_type,
            _opt_float(params.get("duration_minutes")),
            _opt_float(params.get("distance_km")),
            _opt_int(params.get("steps")),
            note=_opt_str(params.get("note")),
        )
        self.trust.vault.append_audit("agent.record_activity", agent_id, "success", person_id=person_id)
        self.trust.vault.save()
        return {"status": "recorded" if added else "duplicate", "type": "activity", "person_id": person_id}

    def _handle_record_emotion(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        occurred_at = str(params.get("occurred_at", "")).strip()
        name = str(params.get("name", "")).strip()
        if not occurred_at or not name:
            raise VaultError("occurred_at and name are required")
        added = self.trust.vault.record_emotion(
            person_id,
            occurred_at,
            name,
            duration_minutes=_opt_float(params.get("duration_minutes")),
            feelings=_opt_str(params.get("feelings")),
            reflection=_opt_str(params.get("reflection")),
            source=f"agent:{agent_id}",
        )
        self.trust.vault.append_audit("agent.record_emotion", agent_id, "success", person_id=person_id)
        self.trust.vault.save()
        return {"status": "recorded" if added else "duplicate", "type": "emotion", "person_id": person_id}

    def _handle_record_sleep(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        date = str(params.get("date", "")).strip()
        if not date:
            raise VaultError("date is required")
        added = self.trust.vault.record_sleep(
            person_id,
            date,
            duration_minutes=_opt_float(params.get("duration_minutes")),
            bedtime=_opt_str(params.get("bedtime")),
            wake_time=_opt_str(params.get("wake_time")),
            quality=_opt_int(params.get("quality")),
            note=_opt_str(params.get("note")),
            source=f"agent:{agent_id}",
        )
        self.trust.vault.append_audit("agent.record_sleep", agent_id, "success", person_id=person_id)
        self.trust.vault.save()
        return {"status": "recorded" if added else "duplicate", "type": "sleep", "person_id": person_id}

    def _handle_update_activity_note(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        activity_id = str(params.get("activity_id", "")).strip()
        note = params.get("note")
        if not activity_id or note is None:
            raise VaultError("activity_id and note are required")
        updated = self.trust.vault.update_activity_note(person_id, activity_id, str(note))
        if not updated:
            raise VaultError("activity not found for this person")
        self.trust.vault.append_audit("agent.update_activity_note", agent_id, "success", person_id=person_id)
        self.trust.vault.save()
        return {"status": "updated", "type": "activity", "activity_id": activity_id, "person_id": person_id}

    def _handle_request_document_import(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return self.trust.vault.request_document_import(
            person_id,
            agent_id,
            list(params.get("file_types") or []),
            str(params.get("purpose", "")),
        )

    def _handle_get_import_status(self, params: dict[str, Any], *, agent_id: str, person_id: str, profile: Any) -> dict[str, Any]:
        return self.trust.vault.import_request_status(
            str(params["request_id"]), person_id, agent_id
        )

    def _reject_replayed_nonce(self, nonce: str) -> None:
        now = time.monotonic()
        if len(self._seen_nonces) > 5000:
            cutoff = now - self._NONCE_TTL
            self._seen_nonces = {n: t for n, t in self._seen_nonces.items() if t > cutoff}
        seen = self._seen_nonces.get(nonce)
        if seen is not None and now - seen < self._NONCE_TTL:
            raise VaultError("replayed request nonce")
        self._seen_nonces[nonce] = now


class LocalHealthClient:
    CONNECT_RETRIES = 200

    def __init__(
        self,
        socket_path: Path,
        agent_id: str,
        token: str,
        host_id: str,
        person_id: str,
        challenge_response: bool = True,
    ):
        self.socket_path = socket_path
        self.agent_id = agent_id
        self.token = token
        self.host_id = host_id
        self.person_id = person_id
        # The A0 ephemeral broker verifies this against the kernel-reported peer
        # PID (macOS LOCAL_PEERPID), so a stolen capability cannot be replayed
        # from another process. The A1 daemon ignores the field.
        self._peer_pid = os.getpid()
        # Daemon path proves the token via HMAC(nonce) so the raw token never
        # crosses the wire; the ephemeral broker path still sends it.
        self._challenge_response = challenge_response

    def _proof(self, nonce: str, method: str, person_id: str | None = None) -> str:
        digest = hashlib.sha256(self.token.encode("utf-8")).hexdigest()
        pid = person_id or self.person_id
        message = f"{nonce}:{self.agent_id}:{pid}:{method}".encode("utf-8")
        return hmac.new(digest.encode("ascii"), message, hashlib.sha256).hexdigest()

    def call(self, method: str, params: dict[str, Any] | None = None, person_id: str | None = None) -> dict[str, Any]:
        pid = person_id or self.person_id
        request = {
            "id": os.urandom(8).hex(),
            "agent_id": self.agent_id,
            "session_id": self.agent_id,
            "host_id": self.host_id,
            "person_id": pid,
            "peer_pid": self._peer_pid,
            "method": method,
            "params": params or {},
        }
        if self._challenge_response:
            nonce = secrets.token_hex(16)
            request["nonce"] = nonce
            request["proof"] = self._proof(nonce, method, pid)
        else:
            request["token"] = self.token
        data = b""
        last_error: OSError | None = None
        for attempt in range(self.CONNECT_RETRIES):
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    # The daemon reopens the Vault (PBKDF2 600k + state decrypt)
                    # per request; give it generous headroom.
                    connection.settimeout(20)
                    connection.connect(str(self.socket_path))
                    connection.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
                    while not data.endswith(b"\n"):
                        chunk = connection.recv(1024 * 1024)
                        if not chunk:
                            break
                        data += chunk
                break
            except (FileNotFoundError, ConnectionRefusedError) as exc:
                last_error = exc
                if attempt == self.CONNECT_RETRIES - 1:
                    raise
                time.sleep(0.025)
        if not data and last_error:
            raise last_error
        if not data:
            raise VaultError("daemon closed the IPC connection")
        response = json.loads(data.decode("utf-8"))
        if not response.get("ok"):
            raise VaultError(response.get("error", "daemon request failed"))
        return response["result"]
