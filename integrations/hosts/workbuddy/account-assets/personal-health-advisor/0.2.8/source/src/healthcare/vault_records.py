"""Daily record domain: vitals, medications, activities, emotions, sleep and their edit/delete paths."""

from __future__ import annotations

from .vault_support import (
    VaultError,
)
import json
import math
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


class RecordDomainMixin:
    """Mixin: assembled into vault.VaultStore."""

    def record_vital(
        self,
        person_id: str,
        measured_at: str,
        systolic_mmHg: int | None = None,
        diastolic_mmHg: int | None = None,
        heart_rate_bpm: int | None = None,
        weight_kg: float | None = None,
        context: dict[str, Any] | None = None,
        note: str | None = None,
        source: str | None = None,
    ) -> bool:
        """Append one daily vital reading; returns False if already recorded.

        The label lands in the record's ``source`` field (e.g. 晨间/晚间);
        ``note`` is kept as the legacy alias for it.
        """
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        for existing in self.state["vitals"].values():
            if (
                existing.get("person_id") == person_id
                and existing.get("measured_at") == measured_at
                and existing.get("systolic_mmHg") == systolic_mmHg
                and existing.get("diastolic_mmHg") == diastolic_mmHg
                and existing.get("weight_kg") == weight_kg
            ):
                return False
        record = VitalMeasurement(
            id=new_id("vital"),
            person_id=person_id,
            measured_at=measured_at,
            systolic_mmHg=systolic_mmHg,
            diastolic_mmHg=diastolic_mmHg,
            heart_rate_bpm=heart_rate_bpm,
            weight_kg=weight_kg,
            context=context or {},
            source=source or note,
        )
        self.state["vitals"][record.id] = serialize(record)
        self.append_audit("vital.recorded", "control", "success", person_id=person_id, metadata={"measured_at": measured_at})
        return True

    def record_medication(
        self,
        person_id: str,
        taken_at: str,
        medication: str,
        dose: str | None = None,
        unit: str | None = None,
        taken: bool = True,
        note: str | None = None,
        medication_plan_id: str | None = None,
    ) -> bool:
        """Append one medication intake event; returns False if already recorded."""
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        if medication_plan_id:
            plan = self.state["medication_plans"].get(medication_plan_id)
            if not plan or plan.get("person_id") != person_id:
                raise VaultError("medication plan is not assigned to this person")
        for existing in self.state["medications"].values():
            if (
                existing.get("person_id") == person_id
                and existing.get("taken_at") == taken_at
                and existing.get("medication") == medication
                and existing.get("dose") == dose
            ):
                return False
        record = MedicationRecord(
            id=new_id("med"),
            person_id=person_id,
            taken_at=taken_at,
            medication=medication,
            dose=dose,
            unit=unit,
            taken=taken,
            note=note,
            medication_plan_id=medication_plan_id,
        )
        self.state["medications"][record.id] = serialize(record)
        self.append_audit("medication.recorded", "control", "success", person_id=person_id, metadata={"medication": medication})
        return True

    def update_record(
        self, person_id: str, record_type: str, record_id: str, changes: dict[str, Any],
        *, control_session_id: str | None = None, approval_grant_id: str | None = None,
        expected_revision: int | None = None,
    ) -> bool:
        """Patch one health record; identity and original evidence are immutable."""
        specs = {
            "vital": ("vitals", {"measured_at", "systolic_mmHg", "diastolic_mmHg", "heart_rate_bpm", "weight_kg", "context", "note", "source"}, ("measured_at", "systolic_mmHg", "diastolic_mmHg", "weight_kg")),
            "medication": ("medications", {"taken_at", "medication", "dose", "unit", "taken", "note", "medication_plan_id"}, ("taken_at", "medication", "dose")),
            "activity": ("activities", {"date", "activity_type", "duration_minutes", "distance_km", "steps", "calories", "note"}, ("date", "activity_type", "duration_minutes", "note")),
            "emotion": ("emotions", {"occurred_at", "name", "duration_minutes", "feelings", "reflection"}, ("occurred_at", "name", "duration_minutes", "feelings", "reflection")),
            "sleep": ("sleep_records", {"date", "bedtime", "wake_time", "duration_minutes", "quality", "note"}, ("date", "bedtime", "wake_time", "duration_minutes")),
            "observation": ("observations", {"field", "value", "unit", "measured_at", "value_type", "text_value"}, ()),
        }
        if not isinstance(record_type, str) or record_type not in specs:
            raise VaultError("unsupported record type")
        if person_id not in self.state["persons"]:
            raise VaultError("unknown person")
        collection, allowed, identity = specs[record_type]
        if not isinstance(changes, dict) or not changes:
            raise VaultError("changes must be a non-empty object")
        if set(changes) - allowed:
            raise VaultError("unsupported record fields: " + ", ".join(sorted(set(changes) - allowed)))
        if not isinstance(record_id, str) or not record_id.strip():
            raise VaultError("record_id is required")
        existing = self.state[collection].get(record_id)
        if existing is None or existing.get("person_id") != person_id:
            return False
        patch = dict(changes)
        # On vitals the stored field is ``source``; ``note`` is the legacy alias
        # and an explicit ``source`` wins when both are given.
        if record_type == "vital" and "note" in patch:
            if "source" not in patch:
                patch["source"] = patch["note"]
            patch.pop("note")
        candidate = {**existing, **patch}
        required = {"measured_at", "taken_at", "medication", "date", "activity_type", "occurred_at", "name", "field"}
        numeric = {"systolic_mmHg", "diastolic_mmHg", "heart_rate_bpm", "weight_kg", "duration_minutes", "distance_km", "steps", "calories", "value"}
        integers = {"systolic_mmHg", "diastolic_mmHg", "heart_rate_bpm", "steps", "calories"}
        for key, value in patch.items():
            if key in required:
                if not isinstance(value, str) or not value.strip():
                    raise VaultError(f"{key} must be a non-empty string")
                candidate[key] = value.strip()
                if key in {"measured_at", "taken_at", "date", "occurred_at"}:
                    try:
                        datetime.fromisoformat(candidate[key])
                    except ValueError as exc:
                        raise VaultError(f"{key} must be an ISO date or datetime") from exc
            elif key in numeric:
                if value is None and key != "value":
                    continue
                if isinstance(value, bool) or not isinstance(value, (int, float)) or (isinstance(value, float) and not math.isfinite(value)):
                    raise VaultError(f"{key} must be a finite number")
                if key in integers and not isinstance(value, int):
                    raise VaultError(f"{key} must be an integer")
                if key != "value" and (value < 0 or (key not in {"steps", "calories", "distance_km"} and value == 0)):
                    raise VaultError(f"{key} must be positive (counts and distance may be zero)")
            elif key == "quality":
                if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 5):
                    raise VaultError("quality must be an integer between 1 and 5")
            elif key == "taken":
                if not isinstance(value, bool):
                    raise VaultError("taken must be a boolean")
            elif key == "context":
                if not isinstance(value, dict):
                    raise VaultError("context must be an object")
                try:
                    json.dumps(value, allow_nan=False)
                except (ValueError, TypeError) as exc:
                    raise VaultError("context must contain valid JSON") from exc
            elif value is not None:
                if not isinstance(value, str):
                    raise VaultError(f"{key} must be a string or null")
                candidate[key] = value.strip() or None
        if record_type == "vital" and not any(candidate.get(k) is not None for k in numeric - {"value", "duration_minutes", "distance_km", "steps", "calories"}):
            raise VaultError("a vital record must retain at least one measurement")
        if record_type == "sleep" and candidate.get("duration_minutes") is None and not (
            candidate.get("bedtime") and candidate.get("wake_time")
        ):
            raise VaultError("a sleep record must retain a duration or both bedtime and wake_time")
        for other_id, other in self.state[collection].items():
            if identity and other_id != record_id and other.get("person_id") == person_id and all(other.get(k) == candidate.get(k) for k in identity):
                raise VaultError("record update conflicts with an existing record")
        if record_type == "observation":
            from .schemas import validate, SchemaError
            if "unit" in changes and "value" not in changes:
                raise VaultError("unit correction requires the converted value")
            if candidate.get("value_type", "numeric") != "numeric" and not candidate.get("text_value"):
                raise VaultError("non-numeric observations require text_value")
            candidate["revision"] = existing.get("revision", 1) + 1
            candidate["verification_status"] = "user_confirmed"
            try:
                validate(candidate, "observation")
            except SchemaError as exc:
                raise VaultError(str(exc)) from exc
            self._require_control_approval(
                control_session_id, approval_grant_id, expected_revision,
                action="observation.correct", person_id=person_id, target_ids=[record_id],
            )
        before = {key: existing.get(key) for key in patch}
        self.state[collection][record_id] = candidate
        self.append_audit(
            f"{record_type}.updated", "control", "success", person_id=person_id,
            metadata={"record_id": record_id, "changed_fields": sorted(changes),
                      "before": before, "after": {key: candidate.get(key) for key in patch}},
        )
        return True

    def delete_record(
        self, person_id: str, record_type: str, record_id: str,
        *, control_session_id: str | None = None, approval_grant_id: str | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, Any] | None:
        """Physically remove one record; the removed snapshot stays in the audit trail.

        Observation deletion always requires Control approval (same bar as a
        correction). Daily records are gated by the caller (Control grant or the
        daemon's records.write scope). Returns the removed record, or None when
        not found for this person.
        """
        specs = {
            "vital": "vitals",
            "medication": "medications",
            "activity": "activities",
            "emotion": "emotions",
            "sleep": "sleep_records",
            "observation": "observations",
        }
        if not isinstance(record_type, str) or record_type not in specs:
            raise VaultError("unsupported record type")
        if person_id not in self.state["persons"]:
            raise VaultError("unknown person")
        if not isinstance(record_id, str) or not record_id.strip():
            raise VaultError("record_id is required")
        collection = specs[record_type]
        existing = self.state[collection].get(record_id)
        if existing is None or existing.get("person_id") != person_id:
            return None
        if record_type == "observation":
            self._require_control_approval(
                control_session_id, approval_grant_id, expected_revision,
                action="record.delete", person_id=person_id, target_ids=[record_id],
            )
        removed = self.state[collection].pop(record_id)
        self.append_audit(
            f"{record_type}.deleted", "control", "success", person_id=person_id,
            metadata={"record_id": record_id, "removed": removed},
        )
        return removed

    def update_medication(self, person_id: str, medication_id: str, changes: dict[str, Any]) -> bool:
        """Update one medication intake event in place; returns False if not found."""
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        if not changes:
            raise VaultError("at least one medication field must be changed")
        allowed = {"taken_at", "medication", "dose", "unit", "taken", "note"}
        allowed.add("medication_plan_id")
        unknown = set(changes) - allowed
        if unknown:
            raise VaultError(f"unsupported medication fields: {', '.join(sorted(unknown))}")
        existing = self.state["medications"].get(medication_id)
        if existing is None or existing.get("person_id") != person_id:
            return False

        candidate = {**existing, **changes}
        taken_at = str(candidate.get("taken_at", "")).strip()
        medication = str(candidate.get("medication", "")).strip()
        if not taken_at or not medication:
            raise VaultError("taken_at and medication are required")
        candidate["taken_at"] = taken_at
        candidate["medication"] = medication
        if candidate.get("dose") is not None:
            candidate["dose"] = str(candidate["dose"]).strip() or None
        if candidate.get("unit") is not None:
            candidate["unit"] = str(candidate["unit"]).strip() or None
        if candidate.get("note") is not None:
            candidate["note"] = str(candidate["note"]).strip() or None
        candidate["taken"] = bool(candidate.get("taken", True))
        if candidate.get("medication_plan_id"):
            plan = self.state["medication_plans"].get(candidate["medication_plan_id"])
            if not plan or plan.get("person_id") != person_id:
                raise VaultError("medication plan is not assigned to this person")

        for other_id, other in self.state["medications"].items():
            if other_id == medication_id:
                continue
            if (
                other.get("person_id") == person_id
                and other.get("taken_at") == candidate["taken_at"]
                and other.get("medication") == candidate["medication"]
                and other.get("dose") == candidate.get("dose")
            ):
                raise VaultError("medication update conflicts with an existing record")

        existing.update(candidate)
        self.append_audit(
            "medication.updated",
            "control",
            "success",
            person_id=person_id,
            metadata={"medication_id": medication_id, "changed_fields": sorted(changes)},
        )
        return True

    def record_activity(
        self,
        person_id: str,
        date: str,
        activity_type: str,
        duration_minutes: float | None = None,
        distance_km: float | None = None,
        steps: int | None = None,
        calories: int | None = None,
        note: str | None = None,
    ) -> bool:
        """Append one activity session; returns False if an identical session is already recorded.

        同一活动在同一天的多组（set）各自独立成条：note 区分组次，note 不同即视为不同记录。
        """
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        for existing in self.state["activities"].values():
            if (
                existing.get("person_id") == person_id
                and existing.get("date") == date
                and existing.get("activity_type") == activity_type
                and existing.get("duration_minutes") == duration_minutes
                and (existing.get("note") or None) == (note or None)
            ):
                return False
        record = ActivityRecord(
            id=new_id("activity"),
            person_id=person_id,
            date=date,
            activity_type=activity_type,
            duration_minutes=duration_minutes,
            distance_km=distance_km,
            steps=steps,
            calories=calories,
            note=note,
        )
        self.state["activities"][record.id] = serialize(record)
        self.append_audit("activity.recorded", "control", "success", person_id=person_id, metadata={"activity_type": activity_type})
        return True

    def record_emotion(
        self,
        person_id: str,
        occurred_at: str,
        name: str,
        duration_minutes: float | None = None,
        feelings: str | None = None,
        reflection: str | None = None,
        source: str | None = None,
    ) -> bool:
        """Append one emotion record; returns False when the same entry exists."""
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        occurred_at = occurred_at.strip()
        name = name.strip()
        feelings = feelings.strip() if feelings and feelings.strip() else None
        reflection = reflection.strip() if reflection and reflection.strip() else None
        if not occurred_at or not name:
            raise VaultError("occurred_at and name are required")
        if duration_minutes is not None and duration_minutes <= 0:
            raise VaultError("duration_minutes must be positive")
        for existing in self.state["emotions"].values():
            if (
                existing.get("person_id") == person_id
                and existing.get("occurred_at") == occurred_at
                and existing.get("name") == name
                and existing.get("duration_minutes") == duration_minutes
                and existing.get("feelings") == feelings
                and existing.get("reflection") == reflection
            ):
                return False
        record = EmotionRecord(
            id=new_id("emotion"),
            person_id=person_id,
            occurred_at=occurred_at,
            name=name,
            duration_minutes=duration_minutes,
            feelings=feelings,
            reflection=reflection,
            source=source,
        )
        self.state["emotions"][record.id] = serialize(record)
        self.append_audit(
            "emotion.recorded",
            "control",
            "success",
            person_id=person_id,
            metadata={"name": name, "occurred_at": occurred_at},
        )
        return True

    @staticmethod
    def _sleep_duration_minutes(bedtime: str | None, wake_time: str | None) -> float | None:
        """Minutes between bedtime and wake time; a wake time earlier in the
        clock than the bedtime belongs to the next morning. An identical pair
        yields 0 and is rejected as a duration by the caller."""
        if not bedtime or not wake_time:
            return None
        bed = datetime.strptime(bedtime, "%H:%M")
        wake = datetime.strptime(wake_time, "%H:%M")
        minutes = (wake - bed).total_seconds() / 60
        return minutes + 24 * 60 if minutes < 0 else minutes

    def record_sleep(
        self,
        person_id: str,
        date: str,
        duration_minutes: float | None = None,
        bedtime: str | None = None,
        wake_time: str | None = None,
        quality: int | None = None,
        note: str | None = None,
        source: str | None = None,
    ) -> bool:
        """Append one night's sleep; returns False when the same night exists.

        `date` is the wake-up date. Duration may be given directly or derived
        from bedtime plus wake time; at least one of the two is required.
        """
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        date = self._iso_date(date, "date", required=True) or ""
        bedtime = self._clock_time(bedtime, "bedtime")
        wake_time = self._clock_time(wake_time, "wake_time")
        if duration_minutes is None:
            duration_minutes = self._sleep_duration_minutes(bedtime, wake_time)
        if duration_minutes is None:
            raise VaultError("duration_minutes or both bedtime and wake_time are required")
        if isinstance(duration_minutes, bool) or not isinstance(duration_minutes, (int, float)):
            raise VaultError("duration_minutes must be a finite number")
        duration_minutes = float(duration_minutes)
        if not math.isfinite(duration_minutes):
            raise VaultError("duration_minutes must be a finite number")
        if duration_minutes <= 0:
            raise VaultError("duration_minutes must be positive")
        if duration_minutes > 24 * 60:
            raise VaultError("duration_minutes must not exceed 24 hours")
        if isinstance(quality, bool) or (quality is not None and not isinstance(quality, int)):
            raise VaultError("quality must be an integer between 1 and 5")
        if quality is not None and not 1 <= quality <= 5:
            raise VaultError("quality must be an integer between 1 and 5")
        note = note.strip() if note and note.strip() else None
        for existing in self.state["sleep_records"].values():
            if (
                existing.get("person_id") == person_id
                and existing.get("date") == date
                and existing.get("bedtime") == bedtime
                and existing.get("wake_time") == wake_time
                and existing.get("duration_minutes") == duration_minutes
            ):
                return False
        record = SleepRecord(
            id=new_id("sleep"),
            person_id=person_id,
            date=date,
            bedtime=bedtime,
            wake_time=wake_time,
            duration_minutes=duration_minutes,
            quality=quality,
            note=note,
            source=source,
        )
        self.state["sleep_records"][record.id] = serialize(record)
        self.append_audit(
            "sleep.recorded",
            "control",
            "success",
            person_id=person_id,
            metadata={"date": date, "duration_minutes": duration_minutes},
        )
        return True

    def update_activity_note(self, person_id: str, activity_id: str, note: str) -> bool:
        """Update the note of one existing activity record; returns False if not found."""
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        existing = self.state["activities"].get(activity_id)
        if existing is None or existing.get("person_id") != person_id:
            return False
        existing["note"] = note
        self.append_audit("activity.note_updated", "control", "success", person_id=person_id, metadata={"activity_id": activity_id})
        return True
