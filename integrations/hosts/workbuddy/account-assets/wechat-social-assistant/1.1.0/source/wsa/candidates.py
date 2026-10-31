from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import Any

from .profiles import ContactProfile, build_profiles, signal_label, speaker_message_map
from .store import connect, init_db, now_iso


EVENT_CONTEXT_RE = re.compile(
    r"(活动|会议|路演|峰会|沙龙|训练营|分享会|大会|Meetup|meetup|闭门会|同学会|校友|创业营)"
)
SIGNAL_BOOSTS = {
    "project": 20,
    "schedule": 16,
    "question": 12,
    "thanks": 6,
    "needs_reply": 4,
    "birthday": 4,
}


@dataclass(frozen=True)
class RelationshipCandidate:
    id: int | None
    name: str
    source_chat: str
    status: str
    confidence: int
    reasons: tuple[str, ...]
    evidence_captured_at: str | None
    evidence_excerpt: str
    icebreaker_draft: str
    created_at: str | None = None
    updated_at: str | None = None
    confirmed_at: str | None = None
    dismissed_at: str | None = None
    note: str = ""


def discover_relationship_candidates(
    db_path: Path | str,
    *,
    min_confidence: int = 45,
    limit: int | None = None,
) -> list[RelationshipCandidate]:
    init_db(db_path)
    db = Path(db_path)
    if not db.exists():
        return []
    status_by_key = _candidate_status_map(db)
    candidates: list[RelationshipCandidate] = []
    for profile in build_profiles(db):
        if profile.kind != "speaker" or not profile.source_chats:
            continue
        for source_chat in profile.source_chats:
            candidate = _candidate_from_profile(db, profile, source_chat, status_by_key=status_by_key)
            if candidate.confidence >= min_confidence:
                candidates.append(candidate)
    candidates.sort(key=lambda item: (item.confidence, item.evidence_captured_at or "", item.name), reverse=True)
    if limit is not None:
        return candidates[:limit]
    return candidates


def sync_relationship_candidates(
    db_path: Path | str,
    *,
    min_confidence: int = 45,
    limit: int | None = None,
) -> list[RelationshipCandidate]:
    init_db(db_path)
    discovered = discover_relationship_candidates(db_path, min_confidence=min_confidence, limit=limit)
    current_time = now_iso()
    with connect(db_path) as conn:
        for candidate in discovered:
            conn.execute(
                """
                insert into relationship_candidates
                (
                    name, source_chat, status, confidence, reasons_json, evidence_captured_at,
                    evidence_excerpt, icebreaker_draft, created_at, updated_at, note
                )
                values (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, '')
                on conflict(name, source_chat) do update set
                    confidence = excluded.confidence,
                    reasons_json = excluded.reasons_json,
                    evidence_captured_at = excluded.evidence_captured_at,
                    evidence_excerpt = excluded.evidence_excerpt,
                    icebreaker_draft = excluded.icebreaker_draft,
                    updated_at = excluded.updated_at
                where relationship_candidates.status != 'confirmed'
                """,
                (
                    candidate.name,
                    candidate.source_chat,
                    candidate.confidence,
                    json.dumps(list(candidate.reasons), ensure_ascii=False),
                    candidate.evidence_captured_at,
                    candidate.evidence_excerpt,
                    candidate.icebreaker_draft,
                    current_time,
                    current_time,
                ),
            )
        conn.commit()
    return list_relationship_candidates(db_path, limit=limit or 1000)


def list_relationship_candidates(
    db_path: Path | str,
    *,
    status: str | None = None,
    limit: int = 50,
) -> list[RelationshipCandidate]:
    init_db(db_path)
    params: list[Any] = []
    where = ""
    if status:
        where = "where status = ?"
        params.append(status)
    params.append(limit)
    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            select id, name, source_chat, status, confidence, reasons_json,
                   evidence_captured_at, evidence_excerpt, icebreaker_draft,
                   created_at, updated_at, confirmed_at, dismissed_at, note
            from relationship_candidates
            {where}
            order by
                case status when 'pending' then 0 when 'confirmed' then 1 else 2 end,
                confidence desc,
                updated_at desc,
                id desc
            limit ?
            """,
            params,
        ).fetchall()
    return [_candidate_from_row(row) for row in rows]


def confirm_relationship_candidate(
    db_path: Path | str,
    *,
    candidate_id: int | None = None,
    name: str | None = None,
    source_chat: str | None = None,
    confirmed_at: str | None = None,
    note: str = "",
) -> RelationshipCandidate:
    init_db(db_path)
    when = confirmed_at or now_iso()
    row = _find_candidate_row(db_path, candidate_id=candidate_id, name=name, source_chat=source_chat)
    if row is None and name and source_chat:
        sync_relationship_candidates(db_path, min_confidence=0)
        row = _find_candidate_row(db_path, candidate_id=candidate_id, name=name, source_chat=source_chat)
    if row is None:
        raise ValueError("relationship candidate not found")

    candidate_name = row["name"]
    candidate_source = row["source_chat"]
    with connect(db_path) as conn:
        _ensure_person(conn, candidate_name, when, row["evidence_captured_at"])
        conn.execute(
            """
            update relationship_candidates
            set status = 'confirmed',
                confirmed_at = ?,
                dismissed_at = null,
                note = ?,
                updated_at = ?
            where id = ?
            """,
            (when, note, when, int(row["id"])),
        )
        conn.commit()

    confirmed = _find_candidate_row(
        db_path,
        candidate_id=int(row["id"]),
        name=candidate_name,
        source_chat=candidate_source,
    )
    if confirmed is None:  # pragma: no cover - defensive after update
        raise ValueError("relationship candidate not found after confirmation")
    return _candidate_from_row(confirmed)


def render_candidates_markdown(
    candidates: list[RelationshipCandidate],
    *,
    title: str = "人脉候选人",
    empty_message: str = "暂无人脉候选人。",
) -> str:
    lines = [f"# {title}", ""]
    if not candidates:
        return "\n".join(lines + [empty_message]) + "\n"
    lines.extend(
        [
            "| 姓名 | 来源 | 置信度 | 状态 | 理由 | 破冰草稿 |",
            "|---|---|---:|---|---|---|",
        ]
    )
    for candidate in candidates:
        lines.append(
            "| "
            + " | ".join(
                [
                    _cell(candidate.name),
                    _cell(candidate.source_chat),
                    str(candidate.confidence),
                    _cell(candidate.status),
                    _cell("；".join(candidate.reasons)),
                    _cell(candidate.icebreaker_draft),
                ]
            )
            + " |"
        )
    lines.append("")
    for candidate in candidates:
        lines.extend(
            [
                f"## {candidate.name}",
                "",
                f"- 来源群/活动：{candidate.source_chat}",
                f"- 状态：{candidate.status}",
                f"- 置信度：{candidate.confidence}",
                f"- 证据时间：{candidate.evidence_captured_at or '未知'}",
                f"- 证据摘录：{candidate.evidence_excerpt or '暂无'}",
                f"- 破冰草稿：{candidate.icebreaker_draft}",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def candidate_to_dict(candidate: RelationshipCandidate) -> dict[str, Any]:
    return {
        "id": candidate.id,
        "name": candidate.name,
        "source_chat": candidate.source_chat,
        "status": candidate.status,
        "confidence": candidate.confidence,
        "reasons": list(candidate.reasons),
        "evidence_captured_at": candidate.evidence_captured_at,
        "evidence_excerpt": candidate.evidence_excerpt,
        "icebreaker_draft": candidate.icebreaker_draft,
        "created_at": candidate.created_at,
        "updated_at": candidate.updated_at,
        "confirmed_at": candidate.confirmed_at,
        "dismissed_at": candidate.dismissed_at,
        "note": candidate.note,
    }


def _candidate_from_profile(
    db_path: Path,
    profile: ContactProfile,
    source_chat: str,
    *,
    status_by_key: dict[tuple[str, str], dict[str, Any]],
) -> RelationshipCandidate:
    evidence_captured_at, evidence_excerpt = _candidate_evidence(db_path, profile.name, source_chat)
    confidence = _confidence(profile, source_chat, evidence_excerpt=evidence_excerpt)
    reasons = _reasons(profile, source_chat, evidence_excerpt=evidence_excerpt)
    key = (profile.name, source_chat)
    existing = status_by_key.get(key, {})
    return RelationshipCandidate(
        id=existing.get("id"),
        name=profile.name,
        source_chat=source_chat,
        status=existing.get("status", "pending"),
        confidence=confidence,
        reasons=reasons,
        evidence_captured_at=evidence_captured_at or profile.last_seen_at,
        evidence_excerpt=evidence_excerpt or _compact_excerpt(profile.recent_contents),
        icebreaker_draft=_icebreaker_draft(profile.name, source_chat, evidence_excerpt or _compact_excerpt(profile.recent_contents)),
        created_at=existing.get("created_at"),
        updated_at=existing.get("updated_at"),
        confirmed_at=existing.get("confirmed_at"),
        dismissed_at=existing.get("dismissed_at"),
        note=existing.get("note", ""),
    )


def _confidence(profile: ContactProfile, source_chat: str, *, evidence_excerpt: str) -> int:
    score = 35
    if profile.recent_contents:
        score += 8
    score += min(26, sum(SIGNAL_BOOSTS.get(signal, 0) for signal in profile.signals))
    if profile.organizations:
        score += 15
    if profile.identity_hints:
        score += 8
    if profile.links or profile.files:
        score += 8
    if _is_event_like(source_chat):
        score += 12
    if evidence_excerpt:
        score += 5
    return max(0, min(100, score))


def _reasons(profile: ContactProfile, source_chat: str, *, evidence_excerpt: str) -> tuple[str, ...]:
    reasons: list[str] = [f"来自群/活动：{source_chat}"]
    if _is_event_like(source_chat):
        reasons.append("来源像活动/社群场景，适合会后轻量认识")
    if profile.organizations:
        reasons.append(f"有机构线索：{'、'.join(profile.organizations[:3])}")
    if profile.identity_hints:
        reasons.append(f"有身份线索：{'、'.join(profile.identity_hints[:3])}")
    if profile.signals:
        labels = [signal_label(signal) for signal in profile.signals]
        reasons.append(f"有关系信号：{'、'.join(labels)}")
    if profile.links:
        reasons.append("发过链接资料")
    if profile.files:
        reasons.append("发过文件资料")
    if evidence_excerpt:
        reasons.append(f"有可引用内容：{_truncate(evidence_excerpt, 36)}")
    return tuple(_dedupe(reasons))


def _candidate_evidence(db_path: Path, name: str, source_chat: str) -> tuple[str | None, str]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            select c.captured_at,
                   coalesce(c.corrected_text, c.clean_text) as clean_text
            from captures c
            join people p on p.id = c.person_id
            where p.name = ?
            order by c.captured_at desc, c.id desc
            """,
            (source_chat,),
        ).fetchall()
    for row in rows:
        lines = [line.strip() for line in row["clean_text"].splitlines() if line.strip()]
        messages = speaker_message_map(lines, chat_name=source_chat).get(name, [])
        excerpt = _compact_excerpt(messages)
        if excerpt:
            return row["captured_at"], excerpt
    return None, ""


def _candidate_status_map(db_path: Path) -> dict[tuple[str, str], dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            select id, name, source_chat, status, created_at, updated_at, confirmed_at, dismissed_at, note
            from relationship_candidates
            """
        ).fetchall()
    return {
        (row["name"], row["source_chat"]): {
            "id": int(row["id"]),
            "status": row["status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "confirmed_at": row["confirmed_at"],
            "dismissed_at": row["dismissed_at"],
            "note": row["note"],
        }
        for row in rows
    }


def _find_candidate_row(
    db_path: Path | str,
    *,
    candidate_id: int | None,
    name: str | None,
    source_chat: str | None,
):
    with connect(db_path) as conn:
        if candidate_id is not None:
            return conn.execute("select * from relationship_candidates where id = ?", (candidate_id,)).fetchone()
        if name and source_chat:
            return conn.execute(
                "select * from relationship_candidates where name = ? and source_chat = ?",
                (name.strip(), source_chat.strip()),
            ).fetchone()
    return None


def _candidate_from_row(row) -> RelationshipCandidate:
    return RelationshipCandidate(
        id=int(row["id"]),
        name=row["name"],
        source_chat=row["source_chat"],
        status=row["status"],
        confidence=int(row["confidence"]),
        reasons=tuple(json.loads(row["reasons_json"] or "[]")),
        evidence_captured_at=row["evidence_captured_at"],
        evidence_excerpt=row["evidence_excerpt"],
        icebreaker_draft=row["icebreaker_draft"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        confirmed_at=row["confirmed_at"],
        dismissed_at=row["dismissed_at"],
        note=row["note"],
    )


def _ensure_person(conn, name: str, current_time: str, last_interaction_at: str | None) -> None:
    conn.execute(
        """
        insert into people
        (name, aliases_json, notes, created_at, updated_at, last_interaction_at)
        values (?, '[]', '', ?, ?, ?)
        on conflict(name) do update set
            updated_at = excluded.updated_at,
            last_interaction_at = case
                when people.last_interaction_at is null then excluded.last_interaction_at
                when excluded.last_interaction_at is null then people.last_interaction_at
                when people.last_interaction_at < excluded.last_interaction_at then excluded.last_interaction_at
                else people.last_interaction_at
            end
        """,
        (name, current_time, current_time, last_interaction_at),
    )


def _icebreaker_draft(name: str, source_chat: str, excerpt: str) -> str:
    if excerpt:
        return (
            f"{name}，刚在「{source_chat}」看到你提到“{_truncate(excerpt, 42)}”。"
            "这个方向我也在关注，方便后面简单认识一下吗？"
        )
    return f"{name}，刚在「{source_chat}」看到你的分享，方便后面简单认识一下吗？"


def _is_event_like(source_chat: str) -> bool:
    return bool(EVENT_CONTEXT_RE.search(source_chat))


def _compact_excerpt(items) -> str:
    text = "；".join(str(item).strip() for item in items if str(item).strip())
    return _truncate(text, 120)


def _truncate(value: str, max_length: int) -> str:
    text = re.sub(r"\s+", " ", value).strip()
    if len(text) <= max_length:
        return text
    return text[: max_length - 1].rstrip() + "…"


def _dedupe(items: list[str]) -> tuple[str, ...]:
    result: list[str] = []
    for item in items:
        if item not in result:
            result.append(item)
    return tuple(result)


def _cell(value: str) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")
