from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .store import connect, init_db, now_iso
from .timefmt import format_display_time, normalize_datetime


FEEDBACK_ACTIONS = (
    "mark_done",
    "snooze",
    "not_relevant",
    "too_pushy",
    "good_draft",
    "wrong_person",
    "already_close",
    "do_not_contact",
)


@dataclass(frozen=True)
class FeedbackRecord:
    id: int
    person_name: str
    action: str
    note: str
    created_at: str
    until_at: str | None = None


def record_feedback(
    db_path: Path | str,
    *,
    person_name: str,
    action: str,
    note: str = "",
    until_at: str | None = None,
    created_at: str | None = None,
) -> FeedbackRecord:
    init_db(db_path)
    name = person_name.strip()
    if not name:
        raise ValueError("person_name is required")
    if action not in FEEDBACK_ACTIONS:
        raise ValueError(f"unknown feedback action: {action}")
    if action == "snooze" and not until_at:
        raise ValueError("snooze feedback requires until_at")
    created = normalize_datetime(created_at) if created_at else now_iso()
    until = normalize_datetime(until_at) if until_at else None
    with connect(db_path) as conn:
        cursor = conn.execute(
            """
            insert into contact_feedback
            (person_name, action, note, until_at, created_at)
            values (?, ?, ?, ?, ?)
            """,
            (name, action, note, until, created),
        )
        conn.commit()
        feedback_id = int(cursor.lastrowid)
    return FeedbackRecord(
        id=feedback_id,
        person_name=name,
        action=action,
        note=note,
        until_at=until,
        created_at=created,
    )


def list_feedback(
    db_path: Path | str,
    *,
    person_name: str | None = None,
    limit: int = 50,
) -> list[FeedbackRecord]:
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
            select id, person_name, action, note, until_at, created_at
            from contact_feedback
            {where}
            order by created_at desc, id desc
            limit ?
            """,
            params,
        ).fetchall()
    return [_record_from_row(row) for row in rows]


def feedback_by_person(db_path: Path | str) -> dict[str, list[FeedbackRecord]]:
    grouped: dict[str, list[FeedbackRecord]] = {}
    for record in list_feedback(db_path, limit=10000):
        grouped.setdefault(record.person_name, []).append(record)
    return grouped


def render_feedback_markdown(
    records: list[FeedbackRecord],
    *,
    title: str = "反馈记录",
    empty_message: str = "暂无反馈记录。",
) -> str:
    lines = [f"# {title}", ""]
    if not records:
        return "\n".join(lines + [empty_message]) + "\n"
    lines.extend(
        [
            "| 联系人 | 动作 | 生效到 | 记录时间 | 备注 |",
            "|---|---|---|---|---|",
        ]
    )
    for record in records:
        lines.append(
            f"| {_cell(record.person_name)} | {_cell(record.action)} | "
            f"{_cell(format_display_time(record.until_at) if record.until_at else '')} | "
            f"{_cell(format_display_time(record.created_at))} | {_cell(record.note)} |"
        )
    return "\n".join(lines) + "\n"


def feedback_to_dict(record: FeedbackRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "person_name": record.person_name,
        "action": record.action,
        "note": record.note,
        "until_at": record.until_at,
        "created_at": record.created_at,
    }


def _record_from_row(row) -> FeedbackRecord:
    return FeedbackRecord(
        id=int(row["id"]),
        person_name=row["person_name"],
        action=row["action"],
        note=row["note"],
        until_at=row["until_at"],
        created_at=row["created_at"],
    )


def _cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
