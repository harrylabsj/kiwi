from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

from .store import connect, init_db, now_iso


ENRICHMENT_FIELDS: tuple[tuple[str, str], ...] = (
    ("company", "公司"),
    ("role", "职位/角色"),
    ("context", "认识场景"),
    ("tags", "标签"),
    ("notes", "备注"),
    ("next_followup", "下次跟进"),
)
FIELD_BY_LABEL = {label: key for key, label in ENRICHMENT_FIELDS}
LABEL_BY_FIELD = dict(ENRICHMENT_FIELDS)


@dataclass(frozen=True)
class ContactEnrichment:
    id: int
    person_name: str
    fields: dict[str, str]
    source: str
    raw_text: str
    file_path: str | None
    imported_at: str
    updated_at: str


def record_contact_enrichment(
    db_path: Path | str,
    *,
    person_name: str,
    fields: dict[str, str],
    source: str = "obsidian",
    raw_text: str = "",
    file_path: str | None = None,
    imported_at: str | None = None,
) -> ContactEnrichment:
    init_db(db_path)
    name = person_name.strip()
    if not name:
        raise ValueError("person_name is required")
    normalized_fields = normalize_enrichment_fields(fields)
    if not normalized_fields:
        raise ValueError("enrichment fields are required")
    timestamp = imported_at or now_iso()
    payload = json.dumps(normalized_fields, ensure_ascii=False, sort_keys=True)
    with connect(db_path) as conn:
        _ensure_person(conn, name, timestamp)
        conn.execute(
            """
            insert into contact_enrichments
            (person_name, source, fields_json, raw_text, file_path, imported_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?)
            on conflict(person_name) do update set
                source = excluded.source,
                fields_json = excluded.fields_json,
                raw_text = excluded.raw_text,
                file_path = excluded.file_path,
                imported_at = excluded.imported_at,
                updated_at = excluded.updated_at
            """,
            (name, source, payload, raw_text, file_path, timestamp, timestamp),
        )
        conn.commit()
    records = list_contact_enrichments(db_path, person_name=name, limit=1)
    return records[0]


def list_contact_enrichments(
    db_path: Path | str,
    *,
    person_name: str | None = None,
    limit: int = 1000,
) -> list[ContactEnrichment]:
    init_db(db_path)
    params: list[Any] = []
    where = ""
    if person_name:
        where = "where person_name = ?"
        params.append(person_name.strip())
    params.append(limit)
    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            select id, person_name, source, fields_json, raw_text, file_path, imported_at, updated_at
            from contact_enrichments
            {where}
            order by updated_at desc, person_name asc
            limit ?
            """,
            params,
        ).fetchall()
    return [_enrichment_from_row(row) for row in rows]


def enrichment_by_person(db_path: Path | str) -> dict[str, ContactEnrichment]:
    return {record.person_name: record for record in list_contact_enrichments(db_path, limit=10000)}


def normalize_enrichment_fields(fields: dict[str, str]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for key, _label in ENRICHMENT_FIELDS:
        value = str(fields.get(key) or "").strip()
        if value:
            normalized[key] = value
    return normalized


def enrichment_summary(enrichment: ContactEnrichment) -> str:
    parts = [
        enrichment.fields.get("company", ""),
        enrichment.fields.get("role", ""),
        enrichment.fields.get("context", ""),
    ]
    summary = " / ".join(part for part in parts if part)
    return summary or enrichment.fields.get("notes") or enrichment.fields.get("next_followup") or "有手工补充"


def enrichment_to_dict(enrichment: ContactEnrichment) -> dict[str, Any]:
    return {
        "id": enrichment.id,
        "person_name": enrichment.person_name,
        "fields": dict(enrichment.fields),
        "source": enrichment.source,
        "raw_text": enrichment.raw_text,
        "file_path": enrichment.file_path,
        "imported_at": enrichment.imported_at,
        "updated_at": enrichment.updated_at,
    }


def _ensure_person(conn, name: str, timestamp: str) -> None:
    conn.execute(
        """
        insert into people
        (name, aliases_json, notes, created_at, updated_at, last_interaction_at)
        values (?, '[]', '', ?, ?, null)
        on conflict(name) do update set updated_at = excluded.updated_at
        """,
        (name, timestamp, timestamp),
    )


def _enrichment_from_row(row) -> ContactEnrichment:
    return ContactEnrichment(
        id=int(row["id"]),
        person_name=row["person_name"],
        fields=json.loads(row["fields_json"] or "{}"),
        source=row["source"],
        raw_text=row["raw_text"],
        file_path=row["file_path"],
        imported_at=row["imported_at"],
        updated_at=row["updated_at"],
    )
