from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import socketserver
import stat
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import peer
from .vault import VaultError, VaultStore


class EphemeralHealthDaemon:
    """A0 broker that keeps Vault credentials in memory, never in the session file."""

    def __init__(
        self,
        socket_path: Path,
        store: VaultStore,
        session_id: str,
        token: str,
        host_id: str,
        person_id: str,
        scopes: list[str],
        expires_at: str,
        session_file: Path | None = None,
        ready_file: Path | None = None,
        expected_peer_exec_digest: str | None = None,
    ) -> None:
        self.socket_path = socket_path
        self.store = store
        self._vault_path = store.path
        self._vault_passphrase = store.passphrase
        self.session_id = session_id
        self.token_digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        self.host_id = host_id
        self.person_id = person_id
        self.scopes = set(scopes)
        self.expires_at = datetime.fromisoformat(expires_at)
        self.session_file = session_file
        self.ready_file = ready_file
        self.expected_peer_exec_digest = expected_peer_exec_digest
        self.stop_event = threading.Event()
        self.served_request = False
        # Handler threads share this broker; serializing dispatch prevents
        # concurrent _refresh_store calls from dropping each other's writes.
        self._dispatch_lock = threading.Lock()

    def _refresh_store(self) -> None:
        self.store = VaultStore.open(self._vault_path, self._vault_passphrase)

    def _authenticated(
        self,
        request: dict[str, Any],
        scope: str = "observations.read",
        kernel_peer_pid: int | None = None,
    ) -> None:
        if datetime.now(timezone.utc) >= self.expires_at:
            raise VaultError("session capability expired")
        required = ("session_id", "token", "host_id", "person_id")
        if any(key not in request for key in required):
            raise VaultError("missing session request field")
        valid = (
            hmac.compare_digest(str(request["session_id"]), self.session_id)
            and hmac.compare_digest(hashlib.sha256(str(request["token"]).encode("utf-8")).hexdigest(), self.token_digest)
            and hmac.compare_digest(str(request["host_id"]), self.host_id)
            and str(request["person_id"]) == self.person_id
            and scope in self.scopes
        )
        if not valid:
            raise VaultError("session authentication failed")
        self._verify_peer(request, kernel_peer_pid)

    def _verify_peer(self, request: dict[str, Any], kernel_peer_pid: int | None) -> None:
        """Bind the capability to the connecting process when the kernel tells us who it is.

        A stolen token replayed from another process presents a ``peer_pid`` that
        differs from the kernel-verified one, so the request is rejected. When the
        platform cannot report the peer (or the call is in-process for tests) the
        credential checks above remain the whole boundary.
        """
        if kernel_peer_pid is None:
            return
        claimed = request.get("peer_pid")
        if claimed is None:
            raise VaultError("session peer process not identified")
        if int(claimed) != int(kernel_peer_pid):
            raise VaultError("session peer process mismatch")
        if self.expected_peer_exec_digest is not None:
            observed = peer.executable_digest_for_pid(kernel_peer_pid)
            if observed is None or observed != self.expected_peer_exec_digest:
                raise VaultError("session peer executable mismatch")

    def dispatch(self, request: dict[str, Any], kernel_peer_pid: int | None = None) -> dict[str, Any]:
        with self._dispatch_lock:
            return self._dispatch_locked(request, kernel_peer_pid)

    def _dispatch_locked(self, request: dict[str, Any], kernel_peer_pid: int | None = None) -> dict[str, Any]:
        method = request.get("method")
        required_scope = "documents.ingest" if method in {"health_request_document_import", "health_get_import_status"} else "observations.read"
        self._authenticated(request, required_scope, kernel_peer_pid)
        self.served_request = True
        if method != "health_shutdown":
            self._refresh_store()
        params = request.get("params") or {}
        if method == "health_shutdown":
            self.stop_event.set()
            return {"status": "stopping"}
        if method == "health_ping":
            return {"status": "ok", "person_id": self.person_id}
        if method == "health_search_records":
            return {"items": self.store.search(self.person_id, str(params.get("query", ""))), "person_id": self.person_id}
        if method == "health_get_timeline":
            limit = int(params.get("limit", 50))
            if limit < 1 or limit > 200:
                raise VaultError("limit must be between 1 and 200")
            return {"items": self.store.observations(self.person_id)[-limit:], "person_id": self.person_id}
        if method == "health_get_observation_series":
            field = str(params.get("field", ""))
            if not field.strip():
                raise VaultError("field must not be empty")
            return {"items": self.store.observations(self.person_id, field), "person_id": self.person_id, "field": field}
        if method == "health_get_source_evidence":
            return self.store.evidence_for(self.person_id, str(params["observation_id"]))
        if method == "health_get_source_evidence_ref":
            return self.store.source_evidence_for(
                self.person_id,
                str(params["document_id"]),
                str(params["evidence_id"]),
            )
        if method == "health_get_vitals":
            return {"items": self.store.vitals(self.person_id, int(params.get("limit", 5000))), "person_id": self.person_id}
        if method == "health_get_medications":
            return {"items": self.store.medications(self.person_id, int(params.get("limit", 5000))), "person_id": self.person_id}
        if method == "health_get_activities":
            return {"items": self.store.activities(self.person_id, int(params.get("limit", 5000))), "person_id": self.person_id}
        if method == "health_get_emotions":
            return {"items": self.store.emotions(self.person_id, int(params.get("limit", 5000))), "person_id": self.person_id}
        if method == "health_get_sleep_records":
            return {"items": self.store.sleep_records(self.person_id, int(params.get("limit", 5000))), "person_id": self.person_id}
        if method == "health_request_document_import":
            return self.store.request_document_import(
                self.person_id,
                self.session_id,
                list(params.get("file_types") or []),
                str(params.get("purpose", "")),
            )
        if method == "health_get_import_status":
            return self.store.import_request_status(
                str(params["request_id"]), self.person_id, self.session_id
            )
        raise VaultError("unknown session method")

    def serve_forever(self) -> None:
        if len(os.fsencode(self.socket_path)) >= 100:
            raise VaultError("Unix socket path is too long")
        if self.socket_path.exists():
            mode = self.socket_path.stat().st_mode
            if not stat.S_ISSOCK(mode):
                raise VaultError("refusing to replace a non-socket path")
            self.socket_path.unlink()
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        broker = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                line = self.rfile.readline(1024 * 1024)
                if not line:
                    return
                request: dict[str, Any] = {}
                try:
                    request = json.loads(line.decode("utf-8"))
                    kernel_peer_pid = peer.peer_pid(self.connection)
                    result = broker.dispatch(request, kernel_peer_pid)
                    response = {"id": request.get("id"), "ok": True, "result": result}
                except Exception as exc:
                    response = {"id": request.get("id"), "ok": False, "error": str(exc)}
                self.wfile.write((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))

        class Server(socketserver.ThreadingUnixStreamServer):
            daemon_threads = True
            allow_reuse_address = False

        server = Server(str(self.socket_path), Handler)
        os.chmod(self.socket_path, stat.S_IRUSR | stat.S_IWUSR)
        if self.ready_file is not None:
            # Signals issue_session that the socket is bound and serving.
            self.ready_file.touch()
        server.timeout = 0.25
        consumed_grace_until: float | None = None
        try:
            while not self.stop_event.is_set() and datetime.now(timezone.utc) < self.expires_at:
                server.handle_request()
                if self.session_file and not self.session_file.exists() and not self.served_request:
                    consumed_grace_until = consumed_grace_until or time.monotonic() + 5.0
                    if time.monotonic() >= consumed_grace_until:
                        break
        finally:
            server.server_close()
            if self.socket_path.exists() and stat.S_ISSOCK(self.socket_path.stat().st_mode):
                self.socket_path.unlink()
            if self.ready_file is not None:
                try:
                    self.ready_file.unlink()
                except OSError:
                    pass


def main() -> int:
    parser = argparse.ArgumentParser(prog="healthcare-session-broker")
    parser.add_argument("--bootstrap-stdin", action="store_true", required=True)
    args = parser.parse_args()
    try:
        bootstrap = json.loads(os.read(0, 1024 * 1024).decode("utf-8"))
        store = VaultStore.open(Path(bootstrap["vault_path"]), bootstrap["vault_passphrase"])
        broker = EphemeralHealthDaemon(
            Path(bootstrap["socket_path"]),
            store,
            bootstrap["session_id"],
            bootstrap["token"],
            bootstrap["host_id"],
            bootstrap["person_id"],
            list(bootstrap["scopes"]),
            bootstrap["expires_at"],
            Path(bootstrap["session_file"]),
            Path(bootstrap["ready_file"]) if bootstrap.get("ready_file") else None,
            expected_peer_exec_digest=bootstrap.get("expected_peer_exec_digest"),
        )
        broker.serve_forever()
        return 0
    except Exception:
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
