from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from .daemon import LocalHealthClient
from .models import new_id
from .trust import MacOSKeychain, TrustManager
from .vault import SessionError, VaultError, VaultStore, read_session


def create_server(store: VaultStore, person_id: str, scopes: list[str], owner_id: str | None = None) -> FastMCP:
    if "observations.read" not in scopes:
        raise SessionError("session does not include observations.read")
    if person_id not in store.state["persons"]:
        raise SessionError("session person does not exist")

    server = FastMCP(
        "healthCare",
        instructions=(
            "Agent-facing Health Vault. Baseline reads expose only confirmed values; "
            "scoped import requests never accept local paths. Follow evidence_refs for conclusions."
        ),
    )

    def check_person(requested_person_id: str) -> None:
        if requested_person_id != person_id:
            raise ValueError("person is outside the session capability")

    def envelope(
        data: dict[str, Any],
        evidence_refs: list[str] | None = None,
        scope_used: list[str] | None = None,
    ) -> dict[str, Any]:
        return {
            "request_id": new_id("req"),
            "data_revision": int(store.state.get("data_revision", 0)),
            "data": data,
            "evidence_refs": evidence_refs or [],
            "warnings": [],
            "scope_used": scope_used or ["observations.read"],
        }

    requester_id = owner_id or person_id

    @server.tool(name="health_search_records", description="Search confirmed observations for the authorized person.")
    def health_search_records(requested_person_id: str, query: str = "") -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope({"items": store.search(person_id, query), "person_id": person_id})

    @server.tool(name="health_get_timeline", description="Return the confirmed longitudinal observation timeline.")
    def health_get_timeline(requested_person_id: str, limit: int = 50) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 200:
            raise ValueError("limit must be between 1 and 200")
        items = store.observations(person_id)[-limit:]
        return envelope({"items": items, "person_id": person_id})

    @server.tool(name="health_get_observation_series", description="Return one confirmed observation series with units and dates.")
    def health_get_observation_series(requested_person_id: str, field: str, limit: int = 100) -> dict[str, Any]:
        check_person(requested_person_id)
        if not field.strip():
            raise ValueError("field must not be empty")
        if limit < 1 or limit > 500:
            raise ValueError("limit must be between 1 and 500")
        items = store.observations(person_id, field)[-limit:]
        return envelope(
            {"person_id": person_id, "field": field, "items": items},
            [item["evidence_id"] for item in items],
        )

    @server.tool(name="health_get_source_evidence", description="Return the minimal source evidence for a confirmed observation.")
    def health_get_source_evidence(requested_person_id: str, observation_id: str) -> dict[str, Any]:
        check_person(requested_person_id)
        result = store.evidence_for(person_id, observation_id)
        return envelope(result, [result["evidence"]["id"]])

    @server.tool(name="health_get_vitals", description="Return daily blood-pressure vital readings for the authorized person.")
    def health_get_vitals(requested_person_id: str, limit: int = 5000) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 5000:
            raise ValueError("limit must be between 1 and 5000")
        return envelope({"person_id": person_id, "items": store.vitals(person_id, limit)})

    @server.tool(name="health_get_medications", description="Return medication intake records for the authorized person.")
    def health_get_medications(requested_person_id: str, limit: int = 5000) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 5000:
            raise ValueError("limit must be between 1 and 5000")
        return envelope({"person_id": person_id, "items": store.medications(person_id, limit)})

    @server.tool(name="health_get_activities", description="Return exercise/activity records for the authorized person.")
    def health_get_activities(requested_person_id: str, limit: int = 5000) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 5000:
            raise ValueError("limit must be between 1 and 5000")
        return envelope({"person_id": person_id, "items": store.activities(person_id, limit)})

    @server.tool(name="health_get_emotions", description="Return emotion records with duration, feelings and reflection for the authorized person.")
    def health_get_emotions(requested_person_id: str, limit: int = 5000) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 5000:
            raise ValueError("limit must be between 1 and 5000")
        return envelope({"person_id": person_id, "items": store.emotions(person_id, limit)})

    @server.tool(name="health_get_sleep_records", description="Return sleep records (wake-up date, bedtime, wake time, duration, quality) for the authorized person.")
    def health_get_sleep_records(requested_person_id: str, limit: int = 5000) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 5000:
            raise ValueError("limit must be between 1 and 5000")
        return envelope({"person_id": person_id, "items": store.sleep_records(person_id, limit)})

    @server.tool(name="health_get_encounters", description="Return recorded healthcare encounters without inferring diagnoses.")
    def health_get_encounters(requested_person_id: str, limit: int = 500) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope({"person_id": person_id, "items": store.encounters(person_id, limit)})

    @server.tool(name="health_get_diagnosis_mentions", description="Return source-preserving diagnosis mentions, including their context such as suspected or history.")
    def health_get_diagnosis_mentions(requested_person_id: str, limit: int = 500) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope({"person_id": person_id, "items": store.diagnoses(person_id, limit)})

    @server.tool(name="health_get_medication_plans", description="Return user-confirmed medication plans separately from actual intake events.")
    def health_get_medication_plans(requested_person_id: str, limit: int = 500) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope({"person_id": person_id, "items": store.medication_plans(person_id, limit)})

    @server.tool(name="health_get_reminder_rules", description="Return user-controlled reminder rules. A rule is not evidence that a medication was taken.")
    def health_get_reminder_rules(requested_person_id: str, include_paused: bool = False) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope({"person_id": person_id, "items": store.reminder_rules(person_id, include_paused)})

    @server.tool(name="health_get_trend_summary", description="Return deterministic descriptive statistics with coverage and comparability warnings; never a diagnosis.")
    def health_get_trend_summary(requested_person_id: str, source: str, field: str, start: str | None = None, end: str | None = None) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope(store.trend_summary(person_id, source, field, start, end))

    @server.tool(name="health_prepare_visit_summary", description="Prepare a source-linked, user-reviewable visit-summary draft. It never creates a diagnosis or treatment recommendation.")
    def health_prepare_visit_summary(requested_person_id: str, start: str | None = None, end: str | None = None) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope(store.visit_summary(person_id, start, end))

    @server.resource(
        "health://profiles/{requested_person_id}/timeline",
        name="health_profile_timeline",
        description="Confirmed timeline for the session-authorized person.",
        mime_type="application/json",
    )
    def health_profile_timeline(requested_person_id: str) -> str:
        check_person(requested_person_id)
        return json.dumps(
            envelope({"items": store.observations(person_id), "person_id": person_id}),
            ensure_ascii=False,
        )

    @server.resource(
        "health://profiles/{requested_person_id}/observations/{field}",
        name="health_profile_observation_series",
        description="Confirmed observation series for one normalized field.",
        mime_type="application/json",
    )
    def health_profile_observation_series(requested_person_id: str, field: str) -> str:
        check_person(requested_person_id)
        if not field.strip():
            raise ValueError("field must not be empty")
        items = store.observations(person_id, field)
        return json.dumps(envelope({"person_id": person_id, "field": field, "items": items}), ensure_ascii=False)

    @server.resource(
        "health://documents/{document_id}/evidence/{evidence_id}",
        name="health_source_evidence",
        description="Evidence for a confirmed observation, bound to the authorized person.",
        mime_type="application/json",
    )
    def health_source_evidence(document_id: str, evidence_id: str) -> str:
        result = store.source_evidence_for(person_id, document_id, evidence_id)
        return json.dumps(envelope(result, [evidence_id]), ensure_ascii=False)

    if "documents.ingest" in scopes:
        @server.tool(
            name="health_request_document_import",
            description="Request Control to select and import a document; local paths are never accepted.",
        )
        def health_request_document_import(
            requested_person_id: str,
            purpose: str,
            file_types: list[str] | None = None,
        ) -> dict[str, Any]:
            check_person(requested_person_id)
            request = store.request_document_import(person_id, requester_id, file_types or [], purpose)
            return envelope(request, scope_used=["documents.ingest"])

        @server.tool(
            name="health_get_import_status",
            description="Get the status of an import request owned by this Agent session.",
        )
        def health_get_import_status(requested_person_id: str, request_id: str) -> dict[str, Any]:
            check_person(requested_person_id)
            return envelope(
                store.import_request_status(request_id, person_id, requester_id),
                scope_used=["documents.ingest"],
            )

    return server


def create_daemon_server(
    client: LocalHealthClient,
    person_id: str,
    scopes: list[str] | None = None,
    owner_id: str | None = None,
    person_ids: list[str] | None = None,
) -> FastMCP:
    scopes = scopes or ["observations.read"]
    allowed_persons = set(person_ids) if person_ids else {person_id}
    server = FastMCP(
        "healthCare",
        instructions=(
            "Agent-facing Health Vault through the authenticated local daemon. "
            "Reads expose only confirmed values; import requests remain Control-mediated."
        ),
    )

    def check_person(requested_person_id: str) -> None:
        if requested_person_id not in allowed_persons:
            raise ValueError("person is outside the paired Agent scope")

    def envelope(
        data: dict[str, Any],
        evidence_refs: list[str] | None = None,
        scope_used: list[str] | None = None,
    ) -> dict[str, Any]:
        return {
            "request_id": new_id("req"),
            "data_revision": data.pop("data_revision", None),
            "data": data,
            "evidence_refs": evidence_refs or [],
            "warnings": [],
            "scope_used": scope_used or ["observations.read"],
        }

    @server.tool(name="health_search_records", description="Search confirmed observations through the local daemon.")
    def health_search_records(requested_person_id: str, query: str = "") -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope(client.call("health_search_records", {"query": query}, person_id=requested_person_id))

    @server.tool(name="health_get_timeline", description="Return the confirmed longitudinal timeline through the local daemon.")
    def health_get_timeline(requested_person_id: str, limit: int = 50) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 200:
            raise ValueError("limit must be between 1 and 200")
        return envelope(client.call("health_get_timeline", {"limit": limit}, person_id=requested_person_id))

    @server.tool(name="health_get_observation_series", description="Return one observation series through the local daemon.")
    def health_get_observation_series(requested_person_id: str, field: str, limit: int = 100) -> dict[str, Any]:
        check_person(requested_person_id)
        if not field.strip():
            raise ValueError("field must not be empty")
        if limit < 1 or limit > 500:
            raise ValueError("limit must be between 1 and 500")
        result = client.call("health_get_observation_series", {"field": field, "limit": limit}, person_id=requested_person_id)
        return envelope(result, [item["evidence_id"] for item in result.get("items", [])])

    @server.tool(name="health_get_source_evidence", description="Return source evidence through the local daemon.")
    def health_get_source_evidence(requested_person_id: str, observation_id: str) -> dict[str, Any]:
        check_person(requested_person_id)
        result = client.call("health_get_source_evidence", {"observation_id": observation_id}, person_id=requested_person_id)
        return envelope(result, [result["evidence"]["id"]])

    @server.tool(name="health_get_vitals", description="Return daily blood-pressure vital readings through the local daemon.")
    def health_get_vitals(requested_person_id: str, limit: int = 5000) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 5000:
            raise ValueError("limit must be between 1 and 5000")
        return envelope(client.call("health_get_vitals", {"limit": limit}, person_id=requested_person_id))

    @server.tool(name="health_get_medications", description="Return medication intake records through the local daemon.")
    def health_get_medications(requested_person_id: str, limit: int = 5000) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 5000:
            raise ValueError("limit must be between 1 and 5000")
        return envelope(client.call("health_get_medications", {"limit": limit}, person_id=requested_person_id))

    @server.tool(name="health_get_activities", description="Return exercise/activity records through the local daemon.")
    def health_get_activities(requested_person_id: str, limit: int = 5000) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 5000:
            raise ValueError("limit must be between 1 and 5000")
        return envelope(client.call("health_get_activities", {"limit": limit}, person_id=requested_person_id))

    @server.tool(name="health_get_emotions", description="Return emotion records with duration, feelings and reflection through the local daemon.")
    def health_get_emotions(requested_person_id: str, limit: int = 5000) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 5000:
            raise ValueError("limit must be between 1 and 5000")
        return envelope(client.call("health_get_emotions", {"limit": limit}, person_id=requested_person_id))

    @server.tool(name="health_get_sleep_records", description="Return sleep records (wake-up date, bedtime, wake time, duration, quality) through the local daemon.")
    def health_get_sleep_records(requested_person_id: str, limit: int = 5000) -> dict[str, Any]:
        check_person(requested_person_id)
        if limit < 1 or limit > 5000:
            raise ValueError("limit must be between 1 and 5000")
        return envelope(client.call("health_get_sleep_records", {"limit": limit}, person_id=requested_person_id))

    @server.tool(name="health_get_encounters", description="Return recorded healthcare encounters through the local daemon.")
    def health_get_encounters(requested_person_id: str, limit: int = 500) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope(client.call("health_get_encounters", {"limit": limit}, person_id=requested_person_id))

    @server.tool(name="health_get_diagnosis_mentions", description="Return source-preserving diagnosis mentions through the local daemon.")
    def health_get_diagnosis_mentions(requested_person_id: str, limit: int = 500) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope(client.call("health_get_diagnosis_mentions", {"limit": limit}, person_id=requested_person_id))

    @server.tool(name="health_get_medication_plans", description="Return medication plans separately from intake events through the local daemon.")
    def health_get_medication_plans(requested_person_id: str, limit: int = 500) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope(client.call("health_get_medication_plans", {"limit": limit}, person_id=requested_person_id))

    @server.tool(name="health_get_reminder_rules", description="Return user-controlled reminder rules through the local daemon.")
    def health_get_reminder_rules(requested_person_id: str, include_paused: bool = False) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope(client.call("health_get_reminder_rules", {"include_paused": include_paused}, person_id=requested_person_id))

    @server.tool(name="health_get_trend_summary", description="Return deterministic descriptive statistics through the local daemon; never a diagnosis.")
    def health_get_trend_summary(requested_person_id: str, source: str, field: str, start: str | None = None, end: str | None = None) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope(client.call("health_get_trend_summary", {
            "source": source, "field": field, "start": start, "end": end,
        }, person_id=requested_person_id))

    @server.tool(name="health_prepare_visit_summary", description="Prepare a source-linked visit-summary draft through the local daemon.")
    def health_prepare_visit_summary(requested_person_id: str, start: str | None = None, end: str | None = None) -> dict[str, Any]:
        check_person(requested_person_id)
        return envelope(client.call("health_prepare_visit_summary", {"start": start, "end": end}, person_id=requested_person_id))

    if "records.write" in scopes:

        @server.tool(name="health_update_record", description="Edit a daily vital, medication, activity, emotion or sleep record by its id from the corresponding read tool. Pass only changed fields; null clears optional fields. Observation corrections require local Control.")
        def health_update_record(requested_person_id: str, record_type: str, record_id: str, changes: dict[str, Any]) -> dict[str, Any]:
            check_person(requested_person_id)
            result = client.call("health_update_record", {
                "record_type": record_type, "record_id": record_id, "changes": changes,
            }, person_id=requested_person_id)
            return envelope(result, scope_used=["records.write"])

        @server.tool(name="health_delete_record", description="Delete one daily vital, medication, activity, emotion or sleep record by its id from the corresponding read tool. Deletion is physical; the removed snapshot stays in the audit trail. Observation deletion requires local Control.")
        def health_delete_record(requested_person_id: str, record_type: str, record_id: str, reason: str | None = None) -> dict[str, Any]:
            check_person(requested_person_id)
            result = client.call("health_delete_record", {
                "record_type": record_type, "record_id": record_id, "reason": reason,
            }, person_id=requested_person_id)
            return envelope(result, scope_used=["records.write"])

        @server.tool(
            name="health_record_vital",
            description="Record one blood-pressure/weight vital reading for the authorized person. source/note is a free-text label stored on the record (e.g. 晨间/晚间 for the measurement period). Idempotent: duplicates return status=duplicate.",
        )
        def health_record_vital(
            requested_person_id: str,
            measured_at: str,
            systolic_mmHg: int | None = None,
            diastolic_mmHg: int | None = None,
            heart_rate_bpm: int | None = None,
            weight_kg: float | None = None,
            note: str | None = None,
            source: str | None = None,
        ) -> dict[str, Any]:
            check_person(requested_person_id)
            result = client.call("health_record_vital", {
                "measured_at": measured_at,
                "systolic_mmHg": systolic_mmHg,
                "diastolic_mmHg": diastolic_mmHg,
                "heart_rate_bpm": heart_rate_bpm,
                "weight_kg": weight_kg,
                "note": note,
                "source": source,
            }, person_id=requested_person_id)
            return envelope(result, scope_used=["records.write"])

        @server.tool(
            name="health_record_medication",
            description="Record one medication intake event for the authorized person. Idempotent: duplicates return status=duplicate.",
        )
        def health_record_medication(
            requested_person_id: str,
            taken_at: str,
            medication: str,
            dose: str | None = None,
            unit: str | None = None,
            taken: bool = True,
            note: str | None = None,
            medication_plan_id: str | None = None,
        ) -> dict[str, Any]:
            check_person(requested_person_id)
            result = client.call("health_record_medication", {
                "taken_at": taken_at,
                "medication": medication,
                "dose": dose,
                "unit": unit,
                "taken": taken,
                "note": note,
                "medication_plan_id": medication_plan_id,
            }, person_id=requested_person_id)
            return envelope(result, scope_used=["records.write"])

        @server.tool(
            name="health_update_medication",
            description="Update one medication intake record for the authorized person. Read health_get_medications first and pass its medication_id.",
        )
        def health_update_medication(
            requested_person_id: str,
            medication_id: str,
            taken_at: str | None = None,
            medication: str | None = None,
            dose: str | None = None,
            unit: str | None = None,
            taken: bool | None = None,
            note: str | None = None,
            clear_dose: bool = False,
            clear_unit: bool = False,
            clear_note: bool = False,
        ) -> dict[str, Any]:
            check_person(requested_person_id)
            changes = {
                name: value
                for name, value in {
                    "taken_at": taken_at,
                    "medication": medication,
                    "dose": dose,
                    "unit": unit,
                    "taken": taken,
                    "note": note,
                }.items()
                if value is not None
            }
            if clear_dose:
                changes["dose"] = None
            if clear_unit:
                changes["unit"] = None
            if clear_note:
                changes["note"] = None
            result = client.call("health_update_medication", {
                "medication_id": medication_id,
                "changes": changes,
            }, person_id=requested_person_id)
            return envelope(result, scope_used=["records.write"])

        @server.tool(
            name="health_record_activity",
            description="Record one exercise/activity session for the authorized person. Each set of the same activity on one day is its own independent record — use note to distinguish sets (e.g. 第一组90个 / 第二组60个); do NOT merge sets into one note. Identical recordings (same date, type, duration and note) return status=duplicate.",
        )
        def health_record_activity(
            requested_person_id: str,
            date: str,
            activity_type: str,
            duration_minutes: float | None = None,
            distance_km: float | None = None,
            steps: int | None = None,
            note: str | None = None,
        ) -> dict[str, Any]:
            check_person(requested_person_id)
            result = client.call("health_record_activity", {
                "date": date,
                "activity_type": activity_type,
                "duration_minutes": duration_minutes,
                "distance_km": distance_km,
                "steps": steps,
                "note": note,
            }, person_id=requested_person_id)
            return envelope(result, scope_used=["records.write"])

        @server.tool(
            name="health_record_emotion",
            description="Record one named emotion with optional duration, feelings and reflection for the authorized person. Idempotent: duplicates return status=duplicate.",
        )
        def health_record_emotion(
            requested_person_id: str,
            occurred_at: str,
            name: str,
            duration_minutes: float | None = None,
            feelings: str | None = None,
            reflection: str | None = None,
        ) -> dict[str, Any]:
            check_person(requested_person_id)
            result = client.call("health_record_emotion", {
                "occurred_at": occurred_at,
                "name": name,
                "duration_minutes": duration_minutes,
                "feelings": feelings,
                "reflection": reflection,
            }, person_id=requested_person_id)
            return envelope(result, scope_used=["records.write"])

        @server.tool(
            name="health_record_sleep",
            description=(
                "Record one night's sleep for the authorized person. date is the wake-up date, so the night "
                "before belongs to it. Give duration_minutes, or bedtime and wake_time to have the duration "
                "derived. Idempotent: duplicates return status=duplicate."
            ),
        )
        def health_record_sleep(
            requested_person_id: str,
            date: str,
            duration_minutes: float | None = None,
            bedtime: str | None = None,
            wake_time: str | None = None,
            quality: int | None = None,
            note: str | None = None,
        ) -> dict[str, Any]:
            check_person(requested_person_id)
            result = client.call("health_record_sleep", {
                "date": date,
                "duration_minutes": duration_minutes,
                "bedtime": bedtime,
                "wake_time": wake_time,
                "quality": quality,
                "note": note,
            }, person_id=requested_person_id)
            return envelope(result, scope_used=["records.write"])

        @server.tool(
            name="health_update_activity_note",
            description="Update the note of an existing activity record (e.g. correcting the set label like 第一组90个 → 第一组95个). Requires the activity_id from health_get_activities. Do NOT use this to merge separate sets — each set stays its own record.",
        )
        def health_update_activity_note(
            requested_person_id: str,
            activity_id: str,
            note: str,
        ) -> dict[str, Any]:
            check_person(requested_person_id)
            result = client.call("health_update_activity_note", {
                "activity_id": activity_id,
                "note": note,
            }, person_id=requested_person_id)
            return envelope(result, scope_used=["records.write"])

    @server.resource(
        "health://profiles/{requested_person_id}/timeline",
        name="health_profile_timeline",
        description="Confirmed timeline for the session-authorized person.",
        mime_type="application/json",
    )
    def health_profile_timeline(requested_person_id: str) -> str:
        check_person(requested_person_id)
        return json.dumps(envelope(client.call("health_get_timeline", person_id=requested_person_id)), ensure_ascii=False)

    @server.resource(
        "health://profiles/{requested_person_id}/observations/{field}",
        name="health_profile_observation_series",
        description="Confirmed observation series for one normalized field.",
        mime_type="application/json",
    )
    def health_profile_observation_series(requested_person_id: str, field: str) -> str:
        check_person(requested_person_id)
        if not field.strip():
            raise ValueError("field must not be empty")
        return json.dumps(
            envelope(client.call("health_get_observation_series", {"field": field}, person_id=requested_person_id)),
            ensure_ascii=False,
        )

    @server.resource(
        "health://documents/{document_id}/evidence/{evidence_id}",
        name="health_source_evidence",
        description="Evidence for a confirmed observation, bound to the paired person.",
        mime_type="application/json",
    )
    def health_source_evidence(document_id: str, evidence_id: str) -> str:
        result = client.call(
            "health_get_source_evidence_ref",
            {"document_id": document_id, "evidence_id": evidence_id},
        )
        return json.dumps(envelope(result, [evidence_id]), ensure_ascii=False)

    if "documents.ingest" in scopes:
        @server.tool(
            name="health_request_document_import",
            description="Request Control to select and import a document; local paths are never accepted.",
        )
        def health_request_document_import(
            requested_person_id: str,
            purpose: str,
            file_types: list[str] | None = None,
        ) -> dict[str, Any]:
            check_person(requested_person_id)
            return envelope(client.call("health_request_document_import", {
                "purpose": purpose,
                "file_types": file_types or [],
            }), scope_used=["documents.ingest"])

        @server.tool(
            name="health_get_import_status",
            description="Get the status of an import request owned by this Agent session.",
        )
        def health_get_import_status(requested_person_id: str, request_id: str) -> dict[str, Any]:
            check_person(requested_person_id)
            return envelope(
                client.call("health_get_import_status", {"request_id": request_id}),
                scope_used=["documents.ingest"],
            )

    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="healthcare-mcp")
    parser.add_argument("--session-file", type=Path)
    parser.add_argument("--socket", type=Path)
    parser.add_argument("--agent-id")
    parser.add_argument("--host-id")
    parser.add_argument("--person-id")
    args = parser.parse_args(argv)
    try:
        if args.session_file:
            session = read_session(args.session_file)
            client = LocalHealthClient(
                Path(session["socket_path"]),
                session["session_id"],
                session["token"],
                session["host_id"],
                session["person_id"],
                challenge_response=False,
            )
            server = create_daemon_server(client, session["person_id"], session["scopes"], session["session_id"])
        else:
            if not all((args.socket, args.agent_id, args.host_id, args.person_id)):
                raise SessionError("use --session-file or --socket with --agent-id, --host-id and --person-id")
            token = MacOSKeychain().get(TrustManager.SERVICE, args.agent_id)
            if not token:
                raise SessionError("paired Agent token is not present in macOS Keychain")
            client = LocalHealthClient(args.socket, args.agent_id, token, args.host_id, args.person_id)
            # Ask the daemon which scopes this paired Agent actually holds so
            # ingest tools are exposed for Agents that were granted them.
            capabilities = client.call("health_get_capabilities")
            server = create_daemon_server(
                client,
                args.person_id,
                capabilities.get("scopes") or ["observations.read"],
                person_ids=capabilities.get("person_ids"),
            )
        server.run(transport="stdio")
        if args.session_file:
            try:
                client.call("health_shutdown")
            except Exception:
                pass
        return 0
    except (OSError, VaultError, SessionError, ValueError) as exc:
        print(f"healthcare-mcp: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
