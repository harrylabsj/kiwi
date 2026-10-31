from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from email import policy
from email.parser import Parser
from email.utils import getaddresses, parsedate_to_datetime
import hashlib
import json
import mailbox
from pathlib import Path
import re
from typing import Any

from .obsidian_memory import parse_obsidian_contact_file
from .store import connect, init_db, now_iso
from .timefmt import format_display_time


SOURCE_TYPES = ("contacts", "calendar", "meeting", "obsidian", "email", "wechat_archive")


@dataclass(frozen=True)
class RelationshipSource:
    id: int | None
    person_name: str
    source_type: str
    title: str
    occurred_at: str | None
    summary: str
    fields: dict[str, str]
    raw_text: str
    file_path: str | None
    text_hash: str
    imported_at: str
    created_at: str | None = None
    updated_at: str | None = None


@dataclass(frozen=True)
class SourceImportResult:
    scanned_count: int
    parsed_count: int
    imported_count: int
    duplicate_count: int
    by_type: dict[str, int]
    skipped_count: int = 0
    dry_run: bool = False


def import_relationship_sources(
    db_path: Path | str,
    *,
    paths: list[Path | str],
    kind: str = "auto",
    dry_run: bool = False,
    imported_at: str | None = None,
) -> SourceImportResult:
    init_db(db_path)
    files, skipped = _expand_paths(paths, kind=kind)
    parsed: list[RelationshipSource] = []
    imported = 0
    duplicates = 0
    timestamp = imported_at or now_iso()
    for path in files:
        try:
            parsed.extend(_parse_path(path, kind=kind, imported_at=timestamp))
        except UnicodeDecodeError:
            skipped += 1
    if not dry_run:
        for source in parsed:
            inserted = _insert_source(db_path, source)
            if inserted:
                imported += 1
            else:
                duplicates += 1
    by_type: dict[str, int] = {}
    for source in parsed:
        by_type[source.source_type] = by_type.get(source.source_type, 0) + 1
    return SourceImportResult(
        scanned_count=len(files),
        parsed_count=len(parsed),
        imported_count=imported,
        duplicate_count=duplicates,
        by_type=by_type,
        skipped_count=skipped,
        dry_run=dry_run,
    )


def list_relationship_sources(
    db_path: Path | str,
    *,
    person_name: str | None = None,
    source_type: str | None = None,
    limit: int = 100,
) -> list[RelationshipSource]:
    init_db(db_path)
    clauses = []
    params: list[Any] = []
    if person_name:
        clauses.append("person_name = ?")
        params.append(person_name.strip())
    if source_type:
        clauses.append("source_type = ?")
        params.append(source_type.strip())
    where = f"where {' and '.join(clauses)}" if clauses else ""
    params.append(limit)
    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            select id, person_name, source_type, title, occurred_at, summary,
                   fields_json, raw_text, file_path, text_hash, imported_at,
                   created_at, updated_at
            from relationship_sources
            {where}
            order by coalesce(occurred_at, imported_at) desc, id desc
            limit ?
            """,
            params,
        ).fetchall()
    return [_source_from_row(row) for row in rows]


def sources_by_person(db_path: Path | str) -> dict[str, list[RelationshipSource]]:
    grouped: dict[str, list[RelationshipSource]] = {}
    for source in list_relationship_sources(db_path, limit=10000):
        grouped.setdefault(source.person_name, []).append(source)
    return grouped


def render_relationship_sources_markdown(
    sources: list[RelationshipSource],
    *,
    title: str = "多入口关系来源",
    empty_message: str = "暂无多入口关系来源。",
) -> str:
    lines = [f"# {title}", ""]
    if not sources:
        return "\n".join(lines + [empty_message]) + "\n"
    lines.extend(
        [
            "| 联系人 | 类型 | 标题 | 时间 | 摘要 |",
            "|---|---|---|---|---|",
        ]
    )
    for source in sources:
        lines.append(
            f"| {_cell(source.person_name)} | {_cell(source.source_type)} | "
            f"{_cell(source.title)} | {_cell(format_display_time(source.occurred_at) if source.occurred_at else '')} | "
            f"{_cell(source.summary)} |"
        )
    return "\n".join(lines) + "\n"


def source_to_dict(source: RelationshipSource) -> dict[str, Any]:
    return {
        "id": source.id,
        "person_name": source.person_name,
        "source_type": source.source_type,
        "title": source.title,
        "occurred_at": source.occurred_at,
        "summary": source.summary,
        "fields": dict(source.fields),
        "raw_text": source.raw_text,
        "file_path": source.file_path,
        "text_hash": source.text_hash,
        "imported_at": source.imported_at,
        "created_at": source.created_at,
        "updated_at": source.updated_at,
    }


def _insert_source(db_path: Path | str, source: RelationshipSource) -> bool:
    with connect(db_path) as conn:
        _ensure_person(conn, source.person_name, source.imported_at, source.occurred_at)
        cursor = conn.execute(
            """
            insert or ignore into relationship_sources
            (person_name, source_type, title, occurred_at, summary, fields_json,
             raw_text, file_path, text_hash, imported_at, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source.person_name,
                source.source_type,
                source.title,
                source.occurred_at,
                source.summary,
                json.dumps(source.fields, ensure_ascii=False, sort_keys=True),
                source.raw_text,
                source.file_path,
                source.text_hash,
                source.imported_at,
                source.imported_at,
                source.imported_at,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0


def _ensure_person(conn, name: str, current_time: str, occurred_at: str | None) -> None:
    conn.execute(
        """
        insert into people
        (name, aliases_json, notes, created_at, updated_at, last_interaction_at)
        values (?, '[]', '', ?, ?, ?)
        on conflict(name) do update set
            updated_at = excluded.updated_at,
            last_interaction_at = case
                when excluded.last_interaction_at is null then people.last_interaction_at
                when people.last_interaction_at is null then excluded.last_interaction_at
                when people.last_interaction_at < excluded.last_interaction_at then excluded.last_interaction_at
                else people.last_interaction_at
            end
        """,
        (name, current_time, current_time, occurred_at),
    )


def _expand_paths(paths: list[Path | str], *, kind: str) -> tuple[list[Path], int]:
    result: list[Path] = []
    skipped = 0
    for value in paths:
        path = Path(value).expanduser()
        if not path.exists():
            raise ValueError(f"source path does not exist: {path}")
        if path.is_dir():
            if kind == "obsidian" or (kind == "auto" and _looks_like_obsidian_vault(path)):
                people_dir = _obsidian_people_dir(path)
                result.extend(_obsidian_contact_files(people_dir))
            else:
                files = sorted(item for item in path.iterdir() if item.is_file())
                supported = [item for item in files if _is_supported_source_file(item, kind)]
                skipped += len(files) - len(supported)
                result.extend(supported)
        else:
            if _is_supported_source_file(path, kind):
                result.append(path)
            else:
                skipped += 1
    return result, skipped


def _is_supported_source_file(path: Path, kind: str) -> bool:
    return kind != "auto" or _detect_kind(path, kind) is not None


def _looks_like_obsidian_vault(path: Path) -> bool:
    return (path / "社交圈" / "人脉").exists() or _is_obsidian_people_dir(path)


def _is_obsidian_people_dir(path: Path) -> bool:
    return path.name == "人脉" and path.parent.name == "社交圈"


def _obsidian_people_dir(path: Path) -> Path:
    if (path / "社交圈" / "人脉").exists():
        return path / "社交圈" / "人脉"
    if (path / "人脉").exists():
        return path / "人脉"
    return path


def _obsidian_contact_files(people_dir: Path) -> list[Path]:
    return sorted(path for path in people_dir.glob("*.md") if path.stem != "索引")


def _parse_path(path: Path, *, kind: str, imported_at: str) -> list[RelationshipSource]:
    source_kind = _detect_kind(path, kind)
    if source_kind == "contacts":
        return _parse_vcard(path, imported_at=imported_at)
    if source_kind == "calendar":
        return _parse_ics(path, imported_at=imported_at)
    if source_kind == "meeting":
        return _parse_meeting_note(path, imported_at=imported_at)
    if source_kind == "obsidian":
        return _parse_obsidian_note(path, imported_at=imported_at)
    if source_kind == "email":
        return _parse_email(path, imported_at=imported_at)
    return []


def _detect_kind(path: Path, kind: str) -> str | None:
    if kind != "auto":
        return kind
    suffix = path.suffix.lower()
    if suffix == ".vcf":
        return "contacts"
    if suffix == ".ics":
        return "calendar"
    if suffix == ".eml" or suffix == ".mbox":
        return "email"
    if suffix == ".md" and "社交圈" in path.parts and "人脉" in path.parts:
        return "obsidian"
    if suffix in {".md", ".txt"}:
        return "meeting"
    return None


def _parse_vcard(path: Path, *, imported_at: str) -> list[RelationshipSource]:
    cards = _blocks(path.read_text(encoding="utf-8"), "BEGIN:VCARD", "END:VCARD")
    sources: list[RelationshipSource] = []
    for card in cards:
        fields = _key_values(card)
        name = fields.get("FN") or fields.get("N")
        if not name:
            continue
        source_fields = {
            "company": fields.get("ORG", ""),
            "role": fields.get("TITLE", ""),
            "email": fields.get("EMAIL", ""),
            "phone": fields.get("TEL", ""),
            "notes": fields.get("NOTE", ""),
        }
        summary = "；".join(
            item
            for item in (
                source_fields.get("company", ""),
                source_fields.get("role", ""),
                source_fields.get("notes", ""),
            )
            if item
        )
        sources.append(
            _source(
                person_name=name,
                source_type="contacts",
                title="本地通讯录",
                occurred_at=None,
                summary=summary,
                fields=source_fields,
                raw_text=card,
                file_path=path,
                imported_at=imported_at,
            )
        )
    return sources


def _parse_ics(path: Path, *, imported_at: str) -> list[RelationshipSource]:
    events = _blocks(path.read_text(encoding="utf-8"), "BEGIN:VEVENT", "END:VEVENT")
    sources: list[RelationshipSource] = []
    for event in events:
        fields = _key_values(event)
        title = fields.get("SUMMARY", "日历事件")
        occurred_at = _parse_compact_datetime(fields.get("DTSTART"))
        summary = fields.get("DESCRIPTION", "")
        attendees = _attendee_names(event)
        for name in attendees:
            sources.append(
                _source(
                    person_name=name,
                    source_type="calendar",
                    title=title,
                    occurred_at=occurred_at,
                    summary=summary,
                    fields={"attendees": "、".join(attendees)},
                    raw_text=event,
                    file_path=path,
                    imported_at=imported_at,
                )
            )
    return sources


def _parse_meeting_note(path: Path, *, imported_at: str) -> list[RelationshipSource]:
    text = path.read_text(encoding="utf-8")
    title = _markdown_title(text) or path.stem
    occurred_at = _date_line(text)
    attendees = _attendees_from_text(text)
    summary = _summary_text(text, skip_prefixes=("参会人", "Attendees", "日期", "Date"))
    return [
        _source(
            person_name=name,
            source_type="meeting",
            title=title,
            occurred_at=occurred_at,
            summary=summary,
            fields={"attendees": "、".join(attendees)},
            raw_text=text,
            file_path=path,
            imported_at=imported_at,
        )
        for name in attendees
    ]


def _parse_obsidian_note(path: Path, *, imported_at: str) -> list[RelationshipSource]:
    parsed = parse_obsidian_contact_file(path)
    if not parsed.person_name:
        return []
    summary = "；".join(value for value in parsed.fields.values() if value)
    if not summary:
        summary = _summary_text(parsed.raw_text)
    return [
        _source(
            person_name=parsed.person_name,
            source_type="obsidian",
            title="Obsidian 手工补充",
            occurred_at=None,
            summary=summary,
            fields=parsed.fields,
            raw_text=parsed.raw_text,
            file_path=path,
            imported_at=imported_at,
        )
    ]


def _parse_email(path: Path, *, imported_at: str) -> list[RelationshipSource]:
    if path.suffix.lower() == ".mbox":
        sources: list[RelationshipSource] = []
        for message in mailbox.mbox(path):
            sources.extend(_sources_from_email_message(message, path=path, imported_at=imported_at))
        return sources
    message = Parser(policy=policy.default).parsestr(path.read_text(encoding="utf-8"))
    return _sources_from_email_message(message, path=path, imported_at=imported_at)


def _sources_from_email_message(message, *, path: Path, imported_at: str) -> list[RelationshipSource]:
    subject = str(message.get("Subject") or "邮件")
    occurred_at = _email_date(message.get("Date"))
    people = _email_people(message)
    body = _email_body(message)
    summary = _summary_text(body)
    return [
        _source(
            person_name=name,
            source_type="email",
            title=subject,
            occurred_at=occurred_at,
            summary=summary,
            fields={"subject": subject},
            raw_text=body,
            file_path=path,
            imported_at=imported_at,
        )
        for name in people
    ]


def _source(
    *,
    person_name: str,
    source_type: str,
    title: str,
    occurred_at: str | None,
    summary: str,
    fields: dict[str, str],
    raw_text: str,
    file_path: Path,
    imported_at: str,
) -> RelationshipSource:
    cleaned_fields = {key: str(value).strip() for key, value in fields.items() if str(value or "").strip()}
    stable = "\n".join([person_name.strip(), source_type, title.strip(), occurred_at or "", summary.strip(), raw_text.strip()])
    return RelationshipSource(
        id=None,
        person_name=person_name.strip(),
        source_type=source_type,
        title=title.strip(),
        occurred_at=occurred_at,
        summary=_truncate(summary, 180),
        fields=cleaned_fields,
        raw_text=raw_text.strip(),
        file_path=str(file_path),
        text_hash=hashlib.sha256(stable.encode("utf-8")).hexdigest(),
        imported_at=imported_at,
    )


def _blocks(text: str, start: str, end: str) -> list[str]:
    blocks: list[str] = []
    current: list[str] = []
    in_block = False
    for line in _unfold_lines(text):
        if line.strip() == start:
            current = [line]
            in_block = True
            continue
        if in_block:
            current.append(line)
        if line.strip() == end and in_block:
            blocks.append("\n".join(current))
            in_block = False
    return blocks


def _unfold_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw_line in text.splitlines():
        if raw_line.startswith((" ", "\t")) and lines:
            lines[-1] += raw_line.strip()
        else:
            lines.append(raw_line.rstrip())
    return lines


def _key_values(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in _unfold_lines(text):
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        normalized = key.split(";", 1)[0].upper()
        values.setdefault(normalized, _clean_escaped(value))
    return values


def _attendee_names(event: str) -> list[str]:
    names: list[str] = []
    for line in _unfold_lines(event):
        if not line.upper().startswith("ATTENDEE"):
            continue
        cn_match = re.search(r"(?:^|;)CN=([^;:]+)", line, flags=re.IGNORECASE)
        if cn_match:
            names.append(_clean_escaped(cn_match.group(1)))
            continue
        if ":" in line:
            value = line.split(":", 1)[1]
            names.append(value.rsplit(":", 1)[-1].split("@", 1)[0])
    return _dedupe(names)


def _parse_compact_datetime(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip().rstrip("Z")
    for fmt in ("%Y%m%dT%H%M%S", "%Y%m%d"):
        try:
            parsed = datetime.strptime(cleaned, fmt)
        except ValueError:
            continue
        return parsed.isoformat()
    return value


def _markdown_title(text: str) -> str | None:
    for line in text.splitlines():
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            return match.group(1).strip()
    return None


def _date_line(text: str) -> str | None:
    for line in text.splitlines():
        match = re.search(r"(?:日期|Date)\s*[：:]\s*(\d{4}-\d{2}-\d{2})", line, flags=re.IGNORECASE)
        if match:
            return match.group(1)
    return None


def _attendees_from_text(text: str) -> list[str]:
    for line in text.splitlines():
        match = re.search(r"(?:参会人|Attendees)\s*[：:]\s*(.+)", line, flags=re.IGNORECASE)
        if match:
            return _dedupe(
                item.strip()
                for item in re.split(r"[、,，;；]", match.group(1))
                if item.strip()
            )
    return []


def _email_people(message) -> list[str]:
    headers = [str(message.get(name) or "") for name in ("From", "To", "Cc")]
    names = []
    for display_name, address in getaddresses(headers):
        names.append(display_name or address.split("@", 1)[0])
    return _dedupe(name for name in names if name)


def _email_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).isoformat(timespec="seconds")
    except (TypeError, ValueError):
        return value


def _email_body(message) -> str:
    if message.is_multipart():
        for part in message.walk():
            if part.get_content_type() == "text/plain":
                return str(part.get_content())
        return ""
    try:
        return str(message.get_content())
    except AttributeError:
        payload = message.get_payload(decode=True)
        return payload.decode("utf-8", errors="replace") if payload else str(message.get_payload())


def _summary_text(text: str, *, skip_prefixes: tuple[str, ...] = ()) -> str:
    lines = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if skip_prefixes and any(line.lower().startswith(prefix.lower()) for prefix in skip_prefixes):
            continue
        lines.append(line)
    return _truncate(" ".join(lines), 180)


def _source_from_row(row) -> RelationshipSource:
    return RelationshipSource(
        id=int(row["id"]),
        person_name=row["person_name"],
        source_type=row["source_type"],
        title=row["title"],
        occurred_at=row["occurred_at"],
        summary=row["summary"],
        fields=json.loads(row["fields_json"] or "{}"),
        raw_text=row["raw_text"],
        file_path=row["file_path"],
        text_hash=row["text_hash"],
        imported_at=row["imported_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _clean_escaped(value: str) -> str:
    return value.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").strip()


def _dedupe(items) -> list[str]:
    result: list[str] = []
    for item in items:
        cleaned = str(item).strip()
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result


def _truncate(value: str, max_length: int) -> str:
    text = re.sub(r"\s+", " ", value).strip()
    if len(text) <= max_length:
        return text
    return text[: max_length - 1].rstrip() + "…"


def _cell(value: str) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")
