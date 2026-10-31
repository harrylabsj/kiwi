"""Experimental MCP v2 stdio entrypoint.

Install with the ``mcp-v2`` extra in an environment that does not also install
the legacy MCP extra. The stable v1 entrypoint remains ``healthcare-mcp``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel

try:
    from mcp.server import MCPServer
except ImportError as exc:  # Keep the legacy extra's v2 console script diagnostic.
    MCPServer = None  # type: ignore[assignment,misc]
    _MCP_V2_IMPORT_ERROR = exc

from healthcare.daemon import LocalHealthClient
from healthcare.vault import SessionError, VaultError, read_session


class HealthResponse(BaseModel):
    request_id: str
    data_revision: int | None
    data: dict[str, Any]
    evidence_refs: list[str]
    warnings: list[str]
    scope_used: list[str]


class RemoteCapability(BaseModel):
    person_id: str
    scopes: list[str]

    def require(self, requested_person_id: str, scope: str) -> None:
        if requested_person_id != self.person_id:
            raise ValueError("person is outside the v2 session capability")
        if scope not in self.scopes:
            raise PermissionError(f"scope required: {scope}")


def create_server(client: LocalHealthClient, capability: RemoteCapability) -> MCPServer:
    server = MCPServer(
        "healthCare-v2",
        version="0.1.0",
        instructions="Read-only confirmed Health Vault data; follow evidence_refs for source evidence.",
    )

    def response(data: dict[str, Any], refs: list[str] | None = None, scope: str = "observations.read") -> HealthResponse:
        return HealthResponse(
            request_id="v2-session-request",
            data_revision=None,
            data=data,
            evidence_refs=refs or [],
            warnings=[],
            scope_used=[scope],
        )

    @server.tool(name="health_search_records", structured_output=True)
    def health_search_records(requested_person_id: str, query: str = "") -> HealthResponse:
        capability.require(requested_person_id, "observations.read")
        return response(client.call("health_search_records", {"query": query}))

    @server.tool(name="health_get_timeline", structured_output=True)
    def health_get_timeline(requested_person_id: str, limit: int = 50) -> HealthResponse:
        capability.require(requested_person_id, "observations.read")
        return response(client.call("health_get_timeline", {"limit": limit}))

    @server.tool(name="health_get_observation_series", structured_output=True)
    def health_get_observation_series(requested_person_id: str, field: str, limit: int = 100) -> HealthResponse:
        capability.require(requested_person_id, "observations.read")
        return response(client.call("health_get_observation_series", {"field": field, "limit": limit}))

    @server.tool(name="health_get_source_evidence", structured_output=True)
    def health_get_source_evidence(requested_person_id: str, observation_id: str) -> HealthResponse:
        capability.require(requested_person_id, "observations.read")
        result = client.call("health_get_source_evidence", {"observation_id": observation_id})
        return response(result, [result["evidence"]["id"]])

    @server.resource("health://profiles/{requested_person_id}/timeline", name="health_profile_timeline", mime_type="application/json")
    def health_profile_timeline(requested_person_id: str) -> str:
        capability.require(requested_person_id, "observations.read")
        return json.dumps(response(client.call("health_get_timeline")).model_dump(), ensure_ascii=False)

    @server.resource("health://documents/{document_id}/evidence/{evidence_id}", name="health_source_evidence", mime_type="application/json")
    def health_source_evidence(document_id: str, evidence_id: str) -> str:
        result = client.call("health_get_source_evidence_ref", {"document_id": document_id, "evidence_id": evidence_id})
        return json.dumps(response(result, [evidence_id]).model_dump(), ensure_ascii=False)

    if "documents.ingest" in capability.scopes:
        @server.tool(name="health_request_document_import", structured_output=True)
        def health_request_document_import(
            requested_person_id: str,
            purpose: str,
            file_types: list[str] | None = None,
        ) -> HealthResponse:
            capability.require(requested_person_id, "documents.ingest")
            result = client.call("health_request_document_import", {
                "purpose": purpose,
                "file_types": file_types or [],
            })
            return response(result, scope="documents.ingest")

        @server.tool(name="health_get_import_status", structured_output=True)
        def health_get_import_status(requested_person_id: str, request_id: str) -> HealthResponse:
            capability.require(requested_person_id, "documents.ingest")
            return response(
                client.call("health_get_import_status", {"request_id": request_id}),
                scope="documents.ingest",
            )

    return server


def main() -> int:
    if MCPServer is None:
        print("healthcare-mcp-v2: install the package with the [mcp-v2] extra", file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser(prog="healthcare-mcp-v2")
    parser.add_argument("--session-file", required=True, type=Path)
    args = parser.parse_args()
    client: LocalHealthClient | None = None
    try:
        session = read_session(args.session_file)
        client = LocalHealthClient(
            Path(session["socket_path"]),
            session["session_id"],
            session["token"],
            session["host_id"],
            session["person_id"],
            challenge_response=False,
        )
        server = create_server(client, RemoteCapability(person_id=session["person_id"], scopes=session["scopes"]))
        server.run(transport="stdio")
        return 0
    except (OSError, VaultError, SessionError, ValueError, PermissionError) as exc:
        print(f"healthcare-mcp-v2: {exc}", file=sys.stderr)
        return 2
    finally:
        if client is not None:
            try:
                client.call("health_shutdown")
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
