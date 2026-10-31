"""Care coordination domain: encounters, diagnosis mentions, medication plans, reminder rules and occurrences, consent grants."""

from __future__ import annotations

from .vault_support import (
    VaultError,
)
from datetime import date, datetime, timedelta, timezone
from typing import Any, IO
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


class CareDomainMixin:
    """Mixin: assembled into vault.VaultStore."""

    def create_encounter(
        self,
        person_id: str,
        occurred_on: str,
        *,
        facility: str | None = None,
        department: str | None = None,
        encounter_type: str = "other",
        note: str | None = None,
        document_ids: list[str] | None = None,
    ) -> Encounter:
        self._require_person(person_id)
        allowed_types = {"outpatient", "inpatient", "emergency", "checkup", "telehealth", "other"}
        if encounter_type not in allowed_types:
            raise VaultError("unsupported encounter_type")
        docs = sorted(set(document_ids or []))
        for document_id in docs:
            self._require_person_document(person_id, document_id)
        encounter = Encounter(
            id=new_id("encounter"),
            person_id=person_id,
            occurred_on=self._iso_date(occurred_on, "occurred_on", required=True),
            facility=facility.strip() if facility and facility.strip() else None,
            department=department.strip() if department and department.strip() else None,
            encounter_type=encounter_type,
            note=note.strip() if note and note.strip() else None,
            document_ids=docs,
        )
        self.state["encounters"][encounter.id] = serialize(encounter)
        self.append_audit(
            "encounter.recorded", "control", "success", person_id=person_id,
            metadata={"encounter_id": encounter.id, "document_count": len(docs)},
        )
        return encounter

    def encounters(self, person_id: str, limit: int = 500) -> list[dict[str, Any]]:
        if limit < 1 or limit > 5000:
            raise VaultError("limit must be between 1 and 5000")
        values = [item for item in self.state["encounters"].values() if item.get("person_id") == person_id]
        return sorted(values, key=lambda item: (item["occurred_on"], item["created_at"]))[-limit:]

    def record_diagnosis_mention(
        self,
        person_id: str,
        text: str,
        context: str,
        *,
        occurred_on: str | None = None,
        encounter_id: str | None = None,
        document_id: str | None = None,
        evidence_id: str | None = None,
    ) -> DiagnosisMention:
        self._require_person(person_id)
        if not isinstance(text, str) or not text.strip():
            raise VaultError("diagnosis text is required")
        allowed_contexts = {"current", "suspected", "ruled_out", "history", "family_history", "other"}
        if context not in allowed_contexts:
            raise VaultError("unsupported diagnosis context")
        if encounter_id:
            encounter = self.state["encounters"].get(encounter_id)
            if not encounter or encounter.get("person_id") != person_id:
                raise VaultError("encounter is not assigned to this person")
        if document_id:
            self._require_person_document(person_id, document_id)
        if evidence_id:
            evidence = self.state["evidence"].get(evidence_id)
            if not evidence or evidence.get("document_id") != document_id:
                raise VaultError("evidence does not belong to the source document")
        mention = DiagnosisMention(
            id=new_id("diagnosis"), person_id=person_id, text=text.strip(), context=context,
            occurred_on=self._iso_date(occurred_on, "occurred_on"), encounter_id=encounter_id,
            document_id=document_id, evidence_id=evidence_id,
        )
        self.state["diagnoses"][mention.id] = serialize(mention)
        self.append_audit(
            "diagnosis.mentioned", "control", "success", person_id=person_id,
            metadata={"diagnosis_id": mention.id, "context": context, "has_source": bool(document_id)},
        )
        return mention

    def diagnoses(self, person_id: str, limit: int = 500) -> list[dict[str, Any]]:
        if limit < 1 or limit > 5000:
            raise VaultError("limit must be between 1 and 5000")
        values = [item for item in self.state["diagnoses"].values() if item.get("person_id") == person_id]
        return sorted(values, key=lambda item: (item.get("occurred_on") or "", item["created_at"]))[-limit:]

    def create_medication_plan(
        self,
        person_id: str,
        medication: str,
        schedule: str,
        *,
        dose: str | None = None,
        unit: str | None = None,
        route: str | None = None,
        starts_on: str | None = None,
        ends_on: str | None = None,
        status: str = "draft",
        source_document_id: str | None = None,
        source_evidence_id: str | None = None,
        user_confirmed: bool = False,
    ) -> MedicationPlan:
        self._require_person(person_id)
        if not medication.strip() or not schedule.strip():
            raise VaultError("medication and schedule are required")
        if status not in {"draft", "active", "paused", "ended"}:
            raise VaultError("unsupported medication plan status")
        if status == "active" and not user_confirmed:
            raise VaultError("an active medication plan requires user confirmation")
        start = self._iso_date(starts_on, "starts_on")
        end = self._iso_date(ends_on, "ends_on")
        if start and end and end < start:
            raise VaultError("ends_on cannot be before starts_on")
        if source_document_id:
            self._require_person_document(person_id, source_document_id)
        if source_evidence_id:
            evidence = self.state["evidence"].get(source_evidence_id)
            if not evidence or evidence.get("document_id") != source_document_id:
                raise VaultError("source evidence does not belong to the source document")
        plan = MedicationPlan(
            id=new_id("medplan"), person_id=person_id, medication=medication.strip(), schedule=schedule.strip(),
            dose=dose.strip() if dose and dose.strip() else None,
            unit=unit.strip() if unit and unit.strip() else None,
            route=route.strip() if route and route.strip() else None,
            starts_on=start, ends_on=end, status=status, source_document_id=source_document_id,
            source_evidence_id=source_evidence_id, user_confirmed=user_confirmed,
        )
        self.state["medication_plans"][plan.id] = serialize(plan)
        self.append_audit(
            "medication_plan.created", "control", "success", person_id=person_id,
            metadata={"medication_plan_id": plan.id, "status": status, "user_confirmed": user_confirmed},
        )
        return plan

    def medication_plans(self, person_id: str, limit: int = 500) -> list[dict[str, Any]]:
        if limit < 1 or limit > 5000:
            raise VaultError("limit must be between 1 and 5000")
        values = [item for item in self.state["medication_plans"].values() if item.get("person_id") == person_id]
        return sorted(values, key=lambda item: (item.get("starts_on") or "", item["created_at"]))[-limit:]

    def update_medication_plan(self, person_id: str, plan_id: str, changes: dict[str, Any]) -> bool:
        self._require_person(person_id)
        plan = self.state["medication_plans"].get(plan_id)
        if not plan or plan.get("person_id") != person_id:
            return False
        allowed = {"medication", "schedule", "dose", "unit", "route", "starts_on", "ends_on", "status", "user_confirmed"}
        if not isinstance(changes, dict) or not changes or set(changes) - allowed:
            raise VaultError("unsupported medication plan changes")
        candidate = {**plan, **changes}
        if not str(candidate.get("medication", "")).strip():
            raise VaultError("medication is required")
        candidate["schedule"] = self._clock_time(candidate.get("schedule"), "schedule", required=True)
        candidate["starts_on"] = self._iso_date(candidate.get("starts_on"), "starts_on")
        candidate["ends_on"] = self._iso_date(candidate.get("ends_on"), "ends_on")
        if candidate["starts_on"] and candidate["ends_on"] and candidate["ends_on"] < candidate["starts_on"]:
            raise VaultError("ends_on cannot be before starts_on")
        if candidate.get("status") not in {"draft", "active", "paused", "ended"}:
            raise VaultError("unsupported medication plan status")
        if candidate.get("status") == "active" and not candidate.get("user_confirmed"):
            raise VaultError("an active medication plan requires user confirmation")
        candidate["revision"] = int(plan.get("revision", 1)) + 1
        self.state["medication_plans"][plan_id] = candidate
        self.append_audit(
            "medication_plan.updated", "control", "success", person_id=person_id,
            metadata={"medication_plan_id": plan_id, "changed_fields": sorted(changes)},
        )
        return True

    def create_reminder_rule(
        self,
        person_id: str,
        kind: str,
        schedule: str,
        title: str,
        *,
        medication_plan_id: str | None = None,
        due_on: str | None = None,
        timezone_name: str = "local",
        quiet_start: str | None = None,
        quiet_end: str | None = None,
    ) -> ReminderRule:
        self._require_person(person_id)
        if kind not in {"record", "medication_plan", "followup"}:
            raise VaultError("unsupported reminder kind")
        schedule_time = self._clock_time(schedule, "schedule", required=True)
        if not title.strip():
            raise VaultError("title is required")
        if kind == "medication_plan":
            plan = self.state["medication_plans"].get(medication_plan_id or "")
            if not plan or plan.get("person_id") != person_id:
                raise VaultError("medication reminder requires this person's plan")
            if plan.get("status") != "active" or not plan.get("user_confirmed"):
                raise VaultError("medication reminder requires an active, user-confirmed plan")
        if kind == "followup" and not due_on:
            raise VaultError("followup reminder requires due_on")
        rule = ReminderRule(
            id=new_id("reminder"), person_id=person_id, kind=kind, schedule=schedule_time,
            title=title.strip(), timezone=timezone_name.strip() or "local", medication_plan_id=medication_plan_id,
            due_on=self._iso_date(due_on, "due_on"),
            quiet_start=self._clock_time(quiet_start, "quiet_start"),
            quiet_end=self._clock_time(quiet_end, "quiet_end"),
        )
        self.state["reminder_rules"][rule.id] = serialize(rule)
        self.append_audit(
            "reminder.created", "control", "success", person_id=person_id,
            metadata={"reminder_id": rule.id, "kind": kind},
        )
        return rule

    def reminder_rules(self, person_id: str, include_paused: bool = False) -> list[dict[str, Any]]:
        values = [item for item in self.state["reminder_rules"].values() if item.get("person_id") == person_id]
        if not include_paused:
            values = [item for item in values if item.get("status") == "active"]
        return sorted(values, key=lambda item: (item["created_at"], item["id"]))

    def set_reminder_rule_status(self, person_id: str, rule_id: str, status: str) -> bool:
        if status not in {"active", "paused", "cancelled"}:
            raise VaultError("unsupported reminder status")
        rule = self.state["reminder_rules"].get(rule_id)
        if not rule or rule.get("person_id") != person_id:
            return False
        rule["status"] = status
        self.append_audit(
            "reminder.status_updated", "control", "success", person_id=person_id,
            metadata={"reminder_id": rule_id, "status": status},
        )
        return True

    @staticmethod
    def _inside_quiet_hours(clock: str, start: str | None, end: str | None) -> bool:
        if not start or not end:
            return False
        if start < end:
            return start <= clock < end
        return clock >= start or clock < end

    def due_reminder_occurrences(self, person_id: str, now_at: str | None = None) -> dict[str, Any]:
        """Generate idempotent local due instances; it never delivers a notification."""
        self._require_person(person_id)
        try:
            now = datetime.fromisoformat(now_at) if now_at else datetime.now().astimezone()
        except ValueError as exc:
            raise VaultError("now_at must be an ISO datetime") from exc
        local_date = now.date().isoformat()
        clock = now.strftime("%H:%M")
        generated: list[dict[str, Any]] = []
        suppressed: list[str] = []
        new_count = 0
        for rule in self.reminder_rules(person_id):
            if rule.get("kind") == "followup" and rule.get("due_on") and rule["due_on"] > local_date:
                continue
            if rule["schedule"] > clock:
                continue
            if self._inside_quiet_hours(clock, rule.get("quiet_start"), rule.get("quiet_end")):
                suppressed.append(rule["id"])
                continue
            scheduled_for = f"{local_date}T{rule['schedule']}:00"
            existing = next(
                (
                    item for item in self.state["reminder_occurrences"].values()
                    if item.get("rule_id") == rule["id"] and item.get("scheduled_for") == scheduled_for
                ),
                None,
            )
            if existing:
                generated.append(existing)
                continue
            occurrence = ReminderOccurrence(
                id=new_id("reminder_occurrence"), rule_id=rule["id"], person_id=person_id,
                scheduled_for=scheduled_for,
            )
            self.state["reminder_occurrences"][occurrence.id] = serialize(occurrence)
            generated.append(self.state["reminder_occurrences"][occurrence.id])
            new_count += 1
        if new_count:
            self.append_audit(
                "reminder.occurrences_generated", "scheduler", "success", person_id=person_id,
                metadata={"count": new_count, "scheduled_date": local_date},
            )
        return {"items": generated, "suppressed_rule_ids": suppressed, "evaluated_at": now.isoformat()}

    def complete_reminder_occurrence(self, person_id: str, occurrence_id: str) -> bool:
        occurrence = self.state["reminder_occurrences"].get(occurrence_id)
        if not occurrence or occurrence.get("person_id") != person_id:
            return False
        if occurrence.get("status") != "completed":
            occurrence["status"] = "completed"
            occurrence["completed_at"] = now_iso()
            self.append_audit(
                "reminder.completed", "control", "success", person_id=person_id,
                metadata={"occurrence_id": occurrence_id},
            )
        return True

    def issue_consent_grant(
        self,
        agent_id: str,
        person_id: str,
        scope: str,
        purpose: str,
        ttl_days: int | None = None,
    ) -> ConsentGrant:
        """Issue a standing, revocable consent for an Agent over one person."""
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        if not agent_id.strip() or not scope.strip() or not purpose.strip():
            raise VaultError("agent_id, scope and purpose are required")
        expires_at: str | None = None
        if ttl_days is not None:
            if ttl_days < 1 or ttl_days > 3650:
                raise VaultError("ttl_days must be between 1 and 3650")
            expires_at = (datetime.now(timezone.utc) + timedelta(days=ttl_days)).replace(microsecond=0).isoformat()
        grant = ConsentGrant(
            id=new_id("consent"),
            agent_id=agent_id,
            person_id=person_id,
            scope=scope,
            purpose=purpose,
            expires_at=expires_at,
        )
        self.state["consent_grants"][grant.id] = serialize(grant)
        self.append_audit(
            "consent.granted", "control", "success",
            person_id=person_id,
            metadata={"agent_id": agent_id, "scope": scope},
        )
        return grant

    def revoke_consent_grant(self, grant_id: str) -> ConsentGrant:
        raw = self.state["consent_grants"].get(grant_id)
        if not raw:
            raise VaultError(f"unknown consent grant: {grant_id}")
        if raw.get("status") != "revoked":
            raw["status"] = "revoked"
            raw["revoked_at"] = now_iso()
            self.append_audit(
                "consent.revoked", "control", "success",
                person_id=raw.get("person_id"),
                metadata={"grant_id": grant_id},
            )
        return ConsentGrant(**raw)

    def active_consent_grants(
        self,
        agent_id: str | None = None,
        person_id: str | None = None,
        scope: str | None = None,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        now = datetime.now(timezone.utc)
        for raw in self.state["consent_grants"].values():
            if agent_id and raw.get("agent_id") != agent_id:
                continue
            if person_id and raw.get("person_id") != person_id:
                continue
            if scope and raw.get("scope") != scope:
                continue
            if raw.get("status") == "revoked":
                continue
            expires = raw.get("expires_at")
            if expires and datetime.fromisoformat(expires) <= now:
                continue
            items.append(raw)
        return items

    def consent_is_active(self, agent_id: str, person_id: str, scope: str) -> bool:
        return bool(self.active_consent_grants(agent_id=agent_id, person_id=person_id, scope=scope))
