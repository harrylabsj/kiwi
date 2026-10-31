"""Document import pipeline: deterministic parsing, LLM extraction, CSV bulk import, identity assignment and candidate review."""

from __future__ import annotations

from .vault_support import (
    VaultError,
    _sha256,
)
import hmac
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
from .object_store import EncryptedObjectStore, ObjectStoreError
from .parser import parse_report, parse_report_date
from .task_mapping import fallback_status_payload


class ImportDomainMixin:
    """Mixin: assembled into vault.VaultStore."""

    def import_text(
        self,
        person_id: str | None,
        filename: str,
        text: str,
        report_date: str | None = None,
        idempotency_key: str | None = None,
        *,
        media_type: str = "text/plain",
        decoder: str | None = "utf8-text",
        source_sha256: str | None = None,
        source_size_bytes: int | None = None,
        page_specs: list[dict[str, Any]] | None = None,
        source_bytes: bytes | None = None,
    ) -> ImportJob:
        if person_id is not None and person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        if idempotency_key:
            existing_job_id = self.state["import_idempotency"].get(idempotency_key)
            if existing_job_id:
                return ImportJob(**self.state["jobs"][existing_job_id])
        pages = page_specs or [{"page_number": 1, "text": text, "media_type": media_type, "decoder": decoder}]
        # Real reports mix text and scanned pages; an empty page is skipped
        # (the source object still preserves the original), but a document
        # with no readable text at all is rejected.
        pages = [page for page in pages if str(page.get("text", "")).strip()]
        if not pages:
            raise VaultError("decoded document must contain non-empty pages")
        text = "\n".join(str(page["text"]) for page in pages)
        raw = text.encode("utf-8")
        object_id: str | None = None
        if source_bytes is not None:
            if source_sha256 and not hmac.compare_digest(source_sha256, _sha256(source_bytes)):
                raise VaultError("source digest does not match decoded input")
            try:
                object_id = self.object_store.put(source_bytes, media_type).object_id
            except ObjectStoreError as exc:
                raise VaultError("unable to store encrypted source object") from exc
        document = SourceDocument(
            id=new_id("doc"),
            person_id=person_id,
            filename=filename,
            sha256=source_sha256 or _sha256(raw),
            source_text=text,
            report_date=parse_report_date(text, report_date or now_iso()[:10]),
            identity_status="confirmed" if person_id else "quarantined",
            media_type=media_type,
            decoder=decoder,
            source_size_bytes=source_size_bytes or len(source_bytes or raw),
            object_id=object_id,
        )
        self.state["documents"][document.id] = serialize(document)
        page_records: list[tuple[DocumentPage, int, int]] = []
        start_line = 1
        for raw_page in pages:
            page = DocumentPage(
                new_id("page"),
                document.id,
                int(raw_page["page_number"]),
                str(raw_page.get("media_type") or media_type),
                str(raw_page.get("decoder") or decoder) if raw_page.get("decoder") or decoder else None,
            )
            self.state["pages"][page.id] = serialize(page)
            line_count = max(1, len(str(raw_page["text"]).splitlines()))
            page_records.append((page, start_line, start_line + line_count - 1))
            start_line += line_count + 1
        self.state["documents"][document.id]["page_line_ranges"] = [
            [page.page_number, first, last] for page, first, last in page_records
        ]
        candidates: list[str] = []
        for parsed in parse_report(text):
            page_number, page_id = self._page_for_locator(parsed.locator, page_records)
            evidence = EvidenceRecord(
                id=new_id("evidence"),
                document_id=document.id,
                page_number=page_number,
                source_text=parsed.source_line,
                locator=parsed.locator,
                page_id=page_id,
            )
            self.state["evidence"][evidence.id] = serialize(evidence)
            candidate_id = new_id("candidate")
            candidate = FieldCandidate(
                id=candidate_id,
                job_id="pending",
                person_id=person_id,
                field=parsed.field,
                raw_value=parsed.raw_value,
                normalized_value=parsed.value,
                unit=parsed.unit,
                confidence=parsed.confidence,
                evidence_id=evidence.id,
                raw_unit=parsed.raw_unit,
                reference_range_original=parsed.reference_range_original,
                raw_comparator=parsed.raw_comparator,
                precision=parsed.precision,
                mapping_status=parsed.mapping_status,
                value_type=parsed.value_type,
                text_value=parsed.text_value,
            )
            self.state["candidates"][candidate_id] = serialize(candidate)
            candidates.append(candidate_id)
        status = "awaiting_review" if person_id else "awaiting_identity"
        job = ImportJob(
            new_id("job"),
            person_id,
            document.id,
            status,
            candidates,
            state=status,
            idempotency_key=idempotency_key,
        )
        self.state["jobs"][job.id] = serialize(job)
        for candidate_id in candidates:
            self.state["candidates"][candidate_id]["job_id"] = job.id
        if idempotency_key:
            self.state["import_idempotency"][idempotency_key] = job.id
        self.save()
        return ImportJob(**self.state["jobs"][job.id])

    @staticmethod
    def _page_for_locator(locator: str, page_records: list[tuple[DocumentPage, int, int]]) -> tuple[int, str | None]:
        try:
            line_number = int(locator.split(":", 1)[1])
        except (IndexError, ValueError):
            return 1, page_records[0][0].id if page_records else None
        for page, first_line, last_line in page_records:
            if first_line <= line_number <= last_line:
                return page.page_number, page.id
        return page_records[-1][0].page_number, page_records[-1][0].id

    def import_decoded_document(
        self,
        person_id: str | None,
        decoded: Any,
        report_date: str | None = None,
        idempotency_key: str | None = None,
        source_bytes: bytes | None = None,
    ) -> ImportJob:
        """Persist a decoder result while keeping evidence page-aware."""
        if not getattr(decoded, "pages", None):
            raise VaultError("decoded document has no pages")
        page_specs = [
            {
                "page_number": page.page_number,
                "text": page.text,
                "media_type": page.media_type,
                "decoder": page.decoder,
            }
            for page in decoded.pages
        ]
        return self.import_text(
            person_id,
            decoded.filename,
            "\n".join(page["text"] for page in page_specs),
            report_date,
            idempotency_key,
            media_type=decoded.media_type,
            decoder=decoded.decoder,
            source_sha256=decoded.source_sha256,
            source_size_bytes=decoded.source_size_bytes,
            page_specs=page_specs,
            source_bytes=source_bytes,
        )

    def import_llm_extraction(
        self,
        filename: str,
        llm_fields: list[Any],
        *,
        person_id: str | None = None,
        report_date: str | None = None,
        idempotency_key: str | None = None,
        source_bytes: bytes | None = None,
        source_media_type: str = "image/*",
    ) -> ImportJob:
        """Import LLM-extracted fields as quarantine candidates.

        Each ``llm_fields`` item is a dataclass with ``field``, ``value``
        (float or str), ``unit``, ``raw_value``, ``value_type`` and
        ``confidence``. Output is candidates only: identity and confirmation
        are still Control-side, exactly like deterministic extraction.
        """
        if person_id is not None and person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        if idempotency_key and idempotency_key in self.state["import_idempotency"]:
            return ImportJob(**self.state["jobs"][self.state["import_idempotency"][idempotency_key]])
        if source_bytes is not None and not source_bytes:
            raise VaultError("LLM source image must not be empty")
        if report_date is not None:
            try:
                report_date = date.fromisoformat(report_date).isoformat()
            except ValueError as exc:
                raise VaultError("report date must be an ISO date") from exc
        text = "\n".join(f"{item.field} {item.raw_value}" for item in llm_fields) or filename
        object_id: str | None = None
        if source_bytes is not None:
            try:
                object_id = self.object_store.put(source_bytes, source_media_type).object_id
            except ObjectStoreError as exc:
                raise VaultError("unable to store encrypted LLM source object") from exc
        document = SourceDocument(
            id=new_id("doc"),
            person_id=person_id,
            filename=filename,
            sha256=_sha256(source_bytes) if source_bytes is not None else _sha256(text.encode("utf-8")),
            source_text=text,
            # A vision model result cannot establish when the report was made.
            # Keep an unknown date null until a user supplies it in Control.
            report_date=report_date,
            identity_status="confirmed" if person_id else "quarantined",
            media_type="application/llm-extraction",
            decoder="llm-vision",
            source_size_bytes=len(source_bytes) if source_bytes is not None else None,
            object_id=object_id,
        )
        self.state["documents"][document.id] = serialize(document)
        candidate_ids: list[str] = []
        for item in llm_fields:
            evidence = EvidenceRecord(
                id=new_id("evidence"),
                document_id=document.id,
                page_number=1,
                source_text=f"{item.field} {item.raw_value}",
                locator="line:1",
            )
            self.state["evidence"][evidence.id] = serialize(evidence)
            numeric = isinstance(item.value, float)
            mapped = item.unit is not None or not numeric
            candidate_id = new_id("candidate")
            candidate = FieldCandidate(
                id=candidate_id,
                job_id="pending",
                person_id=person_id,
                field=item.field,
                raw_value=str(item.raw_value),
                normalized_value=float(item.value) if numeric else 0.0,
                unit=item.unit,
                confidence=float(item.confidence),
                evidence_id=evidence.id,
                raw_unit=getattr(item, "raw_unit", None) or item.unit,
                mapping_status="mapped" if mapped else "unmapped",
                value_type="numeric" if numeric else "text",
                text_value=str(item.value) if not numeric else None,
            )
            self.state["candidates"][candidate_id] = serialize(candidate)
            candidate_ids.append(candidate_id)
        status = "awaiting_review" if person_id else "awaiting_identity"
        job = ImportJob(
            new_id("job"),
            person_id,
            document.id,
            status,
            candidate_ids,
            state=status,
            idempotency_key=idempotency_key,
        )
        self.state["jobs"][job.id] = serialize(job)
        for candidate_id in candidate_ids:
            self.state["candidates"][candidate_id]["job_id"] = job.id
        if idempotency_key:
            self.state["import_idempotency"][idempotency_key] = job.id
        self.append_audit(
            "document.llm_extracted",
            "control",
            "success",
            person_id=person_id,
            metadata={"document_id": document.id, "candidate_count": len(candidate_ids)},
        )
        return ImportJob(**self.state["jobs"][job.id])

    def _csv_import(
        self,
        record_type: str,
        state_key: str,
        person_id: str,
        records: list[dict[str, Any]],
        idempotency_key: str | None,
        build: Any,
    ) -> int:
        if idempotency_key and idempotency_key in self.state["csv_imports"]:
            return 0
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        for raw in records:
            record = build(raw)
            self.state[state_key][record.id] = serialize(record)
        if idempotency_key:
            self.state["csv_imports"][idempotency_key] = {"type": record_type, "count": len(records)}
        self.append_audit(
            f"csv.{record_type}.imported",
            "control",
            "success",
            person_id=person_id,
            metadata={"count": len(records)},
        )
        return len(records)

    def import_vitals(
        self,
        person_id: str,
        records: list[dict[str, Any]],
        idempotency_key: str | None = None,
    ) -> int:
        def build(raw: dict[str, Any]) -> VitalMeasurement:
            return VitalMeasurement(
                id=new_id("vital"),
                person_id=person_id,
                measured_at=raw["measured_at"],
                systolic_mmHg=raw.get("systolic_mmHg"),
                diastolic_mmHg=raw.get("diastolic_mmHg"),
                heart_rate_bpm=raw.get("heart_rate_bpm"),
                weight_kg=raw.get("weight_kg"),
                context=raw.get("context") or {},
                source=raw.get("note"),
            )

        return self._csv_import("vital", "vitals", person_id, records, idempotency_key, build)

    def import_medications(
        self,
        person_id: str,
        records: list[dict[str, Any]],
        idempotency_key: str | None = None,
    ) -> int:
        def build(raw: dict[str, Any]) -> MedicationRecord:
            return MedicationRecord(
                id=new_id("med"),
                person_id=person_id,
                taken_at=raw["taken_at"],
                medication=raw["medication"],
                dose=raw.get("dose"),
                unit=raw.get("unit"),
                taken=bool(raw.get("taken", True)),
                note=raw.get("note"),
            )

        return self._csv_import("medication", "medications", person_id, records, idempotency_key, build)

    def import_activities(
        self,
        person_id: str,
        records: list[dict[str, Any]],
        idempotency_key: str | None = None,
    ) -> int:
        def build(raw: dict[str, Any]) -> ActivityRecord:
            return ActivityRecord(
                id=new_id("activity"),
                person_id=person_id,
                date=raw["date"],
                activity_type=raw["activity_type"],
                duration_minutes=raw.get("duration_minutes"),
                distance_km=raw.get("distance_km"),
                steps=raw.get("steps"),
                calories=raw.get("calories"),
                note=raw.get("note"),
            )

        return self._csv_import("activity", "activities", person_id, records, idempotency_key, build)

    def re_extract_document(self, document_id: str) -> ImportJob:
        """Regenerate candidates for a document with the current parser.

        RFC 12.3: re-running a newer parser creates fresh candidates without
        overwriting human-confirmed values. Fields already confirmed for this
        document are skipped, previous unconfirmed candidates are superseded,
        and the new candidates land in a fresh import job.
        """
        document = self.state["documents"].get(document_id)
        if not document:
            raise VaultError(f"unknown document: {document_id}")
        text = str(document.get("source_text", ""))
        if not text.strip():
            raise VaultError("document has no decoded text to re-extract")
        confirmed_fields = {
            observation["field"]
            for observation in self.state["observations"].values()
            if observation.get("document_id") == document_id
        }
        page_records: list[tuple[DocumentPage, int, int]] = []
        for row in document.get("page_line_ranges") or []:
            page = DocumentPage(new_id("page"), document_id, int(row[0]), "text/plain")
            page_records.append((page, int(row[1]), int(row[2])))
        candidate_ids: list[str] = []
        for field in parse_report(text):
            if field.field in confirmed_fields:
                continue
            if page_records:
                page_number, page_id = self._page_for_locator(field.locator, page_records)
            else:
                page_number, page_id = 1, None
            evidence = EvidenceRecord(
                id=new_id("evidence"),
                document_id=document_id,
                page_number=page_number,
                source_text=field.source_line,
                locator=field.locator,
                page_id=page_id,
            )
            self.state["evidence"][evidence.id] = serialize(evidence)
            candidate_id = new_id("candidate")
            candidate = FieldCandidate(
                id=candidate_id,
                job_id="pending",
                person_id=document.get("person_id"),
                field=field.field,
                raw_value=field.raw_value,
                normalized_value=field.value,
                unit=field.unit,
                confidence=field.confidence,
                evidence_id=evidence.id,
                raw_unit=field.raw_unit,
                reference_range_original=field.reference_range_original,
                raw_comparator=field.raw_comparator,
                precision=field.precision,
                mapping_status=field.mapping_status,
                value_type=field.value_type,
                text_value=field.text_value,
            )
            self.state["candidates"][candidate_id] = serialize(candidate)
            candidate_ids.append(candidate_id)
        for raw_job in self.state["jobs"].values():
            if raw_job.get("document_id") != document_id:
                continue
            for candidate_id in raw_job.get("candidate_ids", []):
                candidate = self.state["candidates"].get(candidate_id)
                if candidate and candidate.get("status") != "confirmed":
                    candidate["status"] = "superseded"
        status = "awaiting_review" if document.get("person_id") else "awaiting_identity"
        job = ImportJob(
            new_id("job"),
            document.get("person_id"),
            document_id,
            status,
            candidate_ids,
            state=status,
        )
        self.state["jobs"][job.id] = serialize(job)
        for candidate_id in candidate_ids:
            self.state["candidates"][candidate_id]["job_id"] = job.id
        self.append_audit(
            "document.re_extracted",
            "control",
            "success",
            person_id=document.get("person_id"),
            metadata={"document_id": document_id, "candidate_count": len(candidate_ids)},
        )
        return ImportJob(**self.state["jobs"][job.id])

    def request_document_import(
        self,
        person_id: str,
        requester_id: str,
        file_types: list[str],
        purpose: str,
        ttl_seconds: int = 1800,
    ) -> dict[str, Any]:
        if person_id not in self.state["persons"]:
            raise VaultError("unknown person")
        if not requester_id.strip() or not purpose.strip():
            raise VaultError("requester_id and purpose are required")
        if ttl_seconds < 60 or ttl_seconds > 7200:
            raise VaultError("ttl_seconds must be between 60 and 7200")
        allowed_types = {"text/plain", "application/pdf", "image/*"}
        normalized_types = sorted(set(file_types or ["application/pdf", "image/*"]))
        if set(normalized_types) - allowed_types:
            raise VaultError("unsupported requested file type")
        request_id = new_id("import_request")
        request = {
            "request_id": request_id,
            "requester_id": requester_id,
            "person_id": person_id,
            "file_types": normalized_types,
            "purpose": purpose.strip()[:300],
            "status": "awaiting_control",
            "job_id": None,
            "confirmation_receipt_id": None,
            "created_at": now_iso(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)).replace(microsecond=0).isoformat(),
        }
        self.state["import_requests"][request_id] = request
        self.append_audit(
            "document.import_requested",
            requester_id,
            "success",
            person_id=person_id,
            metadata={"request_id": request_id, "file_types": normalized_types},
        )
        return dict(request)

    def import_request_status(self, request_id: str, person_id: str, requester_id: str) -> dict[str, Any]:
        request = self.state["import_requests"].get(request_id)
        if not request or request["person_id"] != person_id or request["requester_id"] != requester_id:
            raise VaultError("import request not found")
        if request["status"] == "awaiting_control" and datetime.fromisoformat(request["expires_at"]) <= datetime.now(timezone.utc):
            request["status"] = "expired"
            self.save()
        return {**dict(request), **fallback_status_payload(request)}

    def _sync_import_request_for_job(self, job_id: str, status: str, receipt_id: str | None = None) -> None:
        for request in self.state["import_requests"].values():
            if request.get("job_id") != job_id:
                continue
            request["status"] = status
            if receipt_id:
                request["confirmation_receipt_id"] = receipt_id

    def fulfill_import_request(
        self,
        request_id: str,
        decoded: Any,
        source_bytes: bytes | None = None,
    ) -> ImportJob:
        request = self.state["import_requests"].get(request_id)
        if not request:
            raise VaultError("import request not found")
        if request["status"] != "awaiting_control":
            raise VaultError("import request is not awaiting Control")
        if datetime.fromisoformat(request["expires_at"]) <= datetime.now(timezone.utc):
            request["status"] = "expired"
            self.save()
            raise VaultError("import request expired")
        if decoded.media_type not in request["file_types"] and not (decoded.media_type.startswith("image/") and "image/*" in request["file_types"]):
            raise VaultError("decoded file type is outside the requested scope")
        job = self.import_decoded_document(
            None,
            decoded,
            idempotency_key=f"request:{request_id}",
            source_bytes=source_bytes,
        )
        request["status"] = "awaiting_identity"
        request["job_id"] = job.id
        self.append_audit(
            "document.import_fulfilled",
            "control",
            "success",
            person_id=request["person_id"],
            metadata={"request_id": request_id, "job_id": job.id},
        )
        return job

    def read_source_object(self, person_id: str, document_id: str) -> bytes:
        document = self.state["documents"].get(document_id)
        if not document or document.get("person_id") != person_id or document.get("identity_status") != "confirmed":
            raise VaultError("source document not found")
        object_id = document.get("object_id")
        if not object_id:
            raise VaultError("source object is not stored")
        try:
            return self.object_store.get(object_id)
        except ObjectStoreError as exc:
            raise VaultError("source object integrity check failed") from exc

    def import_text_unassigned(
        self,
        filename: str,
        text: str,
        report_date: str | None = None,
        idempotency_key: str | None = None,
    ) -> ImportJob:
        """Import into quarantine without assuming the document's patient."""
        return self.import_text(None, filename, text, report_date, idempotency_key)

    def assign_document(
        self,
        document_id: str,
        person_id: str,
        actor: str = "control",
        *,
        control_session_id: str | None = None,
        approval_grant_id: str | None = None,
        expected_revision: int | None = None,
    ) -> ImportJob:
        self._require_control_approval(
            control_session_id,
            approval_grant_id,
            expected_revision,
            action="identity.confirm",
            person_id=person_id,
            target_ids=[document_id],
        )
        if person_id not in self.state["persons"]:
            raise VaultError(f"unknown person: {person_id}")
        document = self.state["documents"].get(document_id)
        if not document:
            raise VaultError(f"unknown document: {document_id}")
        if document.get("identity_status") == "confirmed":
            if document.get("person_id") != person_id:
                raise VaultError("document identity is already confirmed for another person")
        else:
            document["person_id"] = person_id
            document["identity_status"] = "confirmed"
            document["revision"] = int(document.get("revision", 1)) + 1
            identity_id = new_id("identity")
            self.state["identities"][identity_id] = {
                "id": identity_id,
                "document_id": document_id,
                "person_id": person_id,
                "status": "confirmed",
                "actor": actor,
                "created_at": now_iso(),
                "document_revision": document["revision"],
            }
        matching_job: ImportJob | None = None
        for raw_job in self.state["jobs"].values():
            if raw_job["document_id"] != document_id:
                continue
            raw_job["person_id"] = person_id
            raw_job["state"] = "awaiting_review" if raw_job["status"] == "awaiting_identity" else raw_job.get("state")
            if raw_job["status"] == "awaiting_identity":
                raw_job["status"] = "awaiting_review"
            for candidate_id in raw_job["candidate_ids"]:
                self.state["candidates"][candidate_id]["person_id"] = person_id
            matching_job = ImportJob(**raw_job)
        if matching_job is None:
            raise VaultError("document has no import job")
        self._sync_import_request_for_job(matching_job.id, matching_job.status)
        self.append_audit(
            "document.identity_confirmed",
            actor,
            "success",
            person_id=person_id,
            metadata={
                "document_id": document_id,
                "control_session_id": control_session_id,
                "approval_grant_id": approval_grant_id,
            },
        )
        return matching_job

    def review_job(
        self,
        job_id: str,
        accept_all: bool = False,
        field: str | None = None,
        value: float | None = None,
        unit: str | None = None,
        *,
        control_session_id: str | None = None,
        approval_grant_id: str | None = None,
        expected_revision: int | None = None,
    ) -> ImportJob:
        if accept_all and (value is not None or unit is not None):
            raise VaultError("value or unit correction cannot be combined with accept-all")
        if (value is not None or unit is not None) and field is None:
            raise VaultError("value or unit correction requires a field")
        if unit is not None and value is None:
            raise VaultError("unit correction requires the converted value")
        raw_job = self.state["jobs"].get(job_id)
        if not raw_job:
            raise VaultError(f"unknown job: {job_id}")
        document = self.state["documents"].get(raw_job["document_id"])
        if not document or document.get("identity_status") != "confirmed":
            raise VaultError("patient identity must be confirmed before review")
        if not document.get("report_date"):
            raise VaultError("report date must be confirmed before review")
        selected = [
            cid
            for cid in raw_job["candidate_ids"]
            if (field is None or self.state["candidates"][cid]["field"] == field)
            and self.state["candidates"][cid].get("status") != "superseded"
        ]
        if not selected:
            raise VaultError("no matching candidate")
        self._require_control_approval(
            control_session_id,
            approval_grant_id,
            expected_revision,
            action="extraction.review",
            person_id=str(raw_job.get("person_id") or ""),
            target_ids=selected,
        )
        job = ImportJob(**raw_job)
        if not job.person_id:
            raise VaultError("patient identity must be confirmed before review")
        confirmed_now = 0
        for candidate_id in selected:
            candidate = self.state["candidates"][candidate_id]
            if candidate.get("status") == "confirmed":
                if value is not None and float(candidate["normalized_value"]) != float(value):
                    raise VaultError("confirmed candidate requires a new correction revision")
                continue
            if value is not None:
                candidate["normalized_value"] = float(value)
            if unit is not None:
                # Control supplies the canonical unit together with the
                # converted value; this is the escape hatch for unmapped units.
                candidate["unit"] = unit
                candidate["mapping_status"] = "mapped"
            if accept_all or value is not None:
                if candidate.get("mapping_status", "mapped") != "mapped":
                    raise VaultError("candidate has an unmapped unit and requires Control correction")
                candidate["status"] = "confirmed"
                candidate["verification_status"] = "user_confirmed"
                observation_id = new_id("obs")
                provenance = ProvenanceRecord(
                    id=new_id("prov"),
                    activity="user_confirmed_extraction",
                    input_id=candidate_id,
                    output_ids=[observation_id],
                    parser="healthcare.numeric-lab-parser",
                    parser_version="0.1.0",
                )
                observation = Observation(
                    id=observation_id,
                    person_id=job.person_id,
                    field=candidate["field"],
                    value=float(candidate["normalized_value"]),
                    unit=candidate["unit"],
                    measured_at=document["report_date"],
                    document_id=job.document_id,
                    evidence_id=candidate["evidence_id"],
                    provenance_id=provenance.id,
                    raw_value=candidate.get("raw_value"),
                    raw_unit=candidate.get("raw_unit") or candidate.get("unit"),
                    reference_range_original=candidate.get("reference_range_original"),
                    raw_comparator=candidate.get("raw_comparator"),
                    mapping_status=candidate.get("mapping_status", "mapped"),
                    value_type=candidate.get("value_type", "numeric"),
                    text_value=candidate.get("text_value"),
                )
                self.state["observations"][observation.id] = serialize(observation)
                self.state["provenance"][provenance.id] = serialize(provenance)
                candidate["observation_id"] = observation_id
                confirmed_now += 1
        statuses = [
            self.state["candidates"][cid]["status"]
            for cid in job.candidate_ids
            if self.state["candidates"][cid].get("status") != "superseded"
        ]
        job.status = "committed" if statuses and all(status == "confirmed" for status in statuses) else "partially_committed"
        job.state = job.status
        job.completed_at = now_iso()
        if confirmed_now:
            receipt = self.append_audit(
                "extraction.confirmed",
                "control",
                "success",
                person_id=job.person_id,
                metadata={
                    "job_id": job.id,
                    "candidate_count": confirmed_now,
                    "control_session_id": control_session_id,
                    "approval_grant_id": approval_grant_id,
                },
            )
            job.confirmation_receipt_id = receipt["id"]
        self._sync_import_request_for_job(job.id, job.status, job.confirmation_receipt_id)
        self.state["jobs"][job.id] = serialize(job)
        self.save()
        return job
