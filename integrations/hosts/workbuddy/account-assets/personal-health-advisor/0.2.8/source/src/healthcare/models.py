from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


@dataclass(slots=True)
class PersonProfile:
    id: str
    display_name: str
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class SourceDocument:
    id: str
    person_id: str | None
    filename: str
    sha256: str
    source_text: str
    # The date may be unknown until the person verifies a report. Unknown dates
    # must never be silently replaced with the import date and used in trends.
    report_date: str | None
    identity_status: str = "unassigned"
    revision: int = 1
    media_type: str = "text/plain"
    decoder: str | None = None
    source_size_bytes: int | None = None
    object_id: str | None = None
    # [[page_number, first_line, last_line], ...] recorded at import so a later
    # re-extract can map a candidate locator back to its source page.
    page_line_ranges: list[list[int]] | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class DocumentPage:
    id: str
    document_id: str
    page_number: int
    media_type: str = "text/plain"
    ocr_version: str | None = None
    image_sha256: str | None = None
    width: int | None = None
    height: int | None = None


@dataclass(slots=True)
class EvidenceRecord:
    id: str
    document_id: str
    page_number: int
    source_text: str
    locator: str
    page_id: str | None = None
    ocr_block_id: str | None = None
    coordinates: dict[str, float] | None = None
    coordinate_system: str | None = None
    source_span: tuple[int, int] | None = None


@dataclass(slots=True)
class FieldCandidate:
    id: str
    job_id: str
    person_id: str | None
    field: str
    raw_value: str
    normalized_value: float
    unit: str | None
    confidence: float
    evidence_id: str
    raw_unit: str | None = None
    reference_range_original: str | None = None
    raw_comparator: str | None = None
    precision: int | None = None
    mapping_status: str = "mapped"
    status: str = "candidate"
    observation_id: str | None = None
    verification_status: str = "candidate"
    value_type: str = "numeric"
    text_value: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class Observation:
    id: str
    person_id: str
    field: str
    value: float
    unit: str | None
    measured_at: str
    document_id: str
    evidence_id: str
    provenance_id: str
    raw_value: str | None = None
    raw_unit: str | None = None
    reference_range_original: str | None = None
    raw_comparator: str | None = None
    verification_status: str = "user_confirmed"
    revision: int = 1
    mapping_status: str = "mapped"
    value_type: str = "numeric"
    text_value: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class VitalMeasurement:
    """A user-recorded daily vital reading (blood pressure etc.), RFC Phase 2."""

    id: str
    person_id: str
    measured_at: str
    systolic_mmHg: int | None = None
    diastolic_mmHg: int | None = None
    heart_rate_bpm: int | None = None
    weight_kg: float | None = None
    context: dict[str, Any] = field(default_factory=dict)
    source: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class MedicationRecord:
    """A user-reported medication intake event, RFC Phase 3 (statement, not plan)."""

    id: str
    person_id: str
    taken_at: str
    medication: str
    dose: str | None = None
    unit: str | None = None
    taken: bool = True
    note: str | None = None
    source: str | None = None
    medication_plan_id: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class ConsentGrant:
    """A standing, revocable authorization for an Agent over a person's data.

    Distinct from the single-use ApprovalGrant: a ConsentGrant is long-lived,
    purpose-bound, time-limited and independently revocable (RFC 6.3, 1A1).
    """

    id: str
    agent_id: str
    person_id: str
    scope: str
    purpose: str
    status: str = "active"
    issued_at: str = field(default_factory=now_iso)
    expires_at: str | None = None
    revoked_at: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class ActivityRecord:
    """A user-recorded exercise/activity session, RFC Phase 2."""

    id: str
    person_id: str
    date: str
    activity_type: str
    duration_minutes: float | None = None
    distance_km: float | None = None
    steps: int | None = None
    calories: int | None = None
    note: str | None = None
    source: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class EmotionRecord:
    """A user-recorded emotion and the meaning they made from it."""

    id: str
    person_id: str
    occurred_at: str
    name: str
    duration_minutes: float | None = None
    feelings: str | None = None
    reflection: str | None = None
    source: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class SleepRecord:
    """A user-recorded night's sleep, RFC Phase 2.

    `date` is the wake-up date: the night of 2026-09-11 23:30 -> 2026-09-12 06:45
    is one record dated 2026-09-12, so "last night" is recorded on the morning
    it ended and a sleep running past midnight never splits across two days.
    """

    id: str
    person_id: str
    date: str
    bedtime: str | None = None
    wake_time: str | None = None
    duration_minutes: float | None = None
    quality: int | None = None
    note: str | None = None
    source: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class Encounter:
    """A user-recorded healthcare encounter; it never implies a diagnosis."""

    id: str
    person_id: str
    occurred_on: str
    facility: str | None = None
    department: str | None = None
    encounter_type: str = "other"
    note: str | None = None
    document_ids: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class DiagnosisMention:
    """Verbatim diagnosis wording with the source context preserved."""

    id: str
    person_id: str
    text: str
    context: str
    occurred_on: str | None = None
    encounter_id: str | None = None
    document_id: str | None = None
    evidence_id: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class MedicationPlan:
    """A user-confirmed medication plan, separate from intake events."""

    id: str
    person_id: str
    medication: str
    schedule: str
    dose: str | None = None
    unit: str | None = None
    route: str | None = None
    starts_on: str | None = None
    ends_on: str | None = None
    status: str = "draft"
    source_document_id: str | None = None
    source_evidence_id: str | None = None
    user_confirmed: bool = False
    revision: int = 1
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class ReminderRule:
    """A deterministic, user-controlled reminder rule; no clinical inference."""

    id: str
    person_id: str
    kind: str
    schedule: str
    title: str
    timezone: str = "local"
    status: str = "active"
    medication_plan_id: str | None = None
    due_on: str | None = None
    quiet_start: str | None = None
    quiet_end: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class ReminderOccurrence:
    """One generated reminder instance, distinct from a delivery or health event."""

    id: str
    rule_id: str
    person_id: str
    scheduled_for: str
    status: str = "due"
    completed_at: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass(slots=True)
class ImportJob:
    id: str
    person_id: str | None
    document_id: str
    status: str
    candidate_ids: list[str]
    state: str | None = None
    idempotency_key: str | None = None
    created_at: str = field(default_factory=now_iso)
    completed_at: str | None = None
    error: str | None = None
    confirmation_receipt_id: str | None = None


@dataclass(slots=True)
class ProvenanceRecord:
    id: str
    activity: str
    input_id: str
    output_ids: list[str]
    parser: str
    parser_version: str
    created_at: str = field(default_factory=now_iso)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


def serialize(value: Any) -> dict[str, Any]:
    return asdict(value)
