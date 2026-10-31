"""Human review workflow for low-confidence OCR observations.

OCR remains raw evidence.  A review creates a separate, auditable correction
and never overwrites the original observation or screenshot.  The current
effective capture text is materialized on ``captures.corrected_text`` so the
existing relationship analysis can consume reviewed text without losing
provenance.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sqlite3
from typing import Any

from .parser import extract_signals
from .store import connect, init_db, now_iso


REVIEW_ACTIONS = ("accept", "reject", "correct")
REVIEW_STATUSES = ("accepted", "rejected", "corrected")
REVIEW_CONFIRMATION_TEXT = "review OCR observation"


class OCRReviewError(ValueError):
    """Raised when a review request is invalid or the observation is missing."""


@dataclass(frozen=True)
class OCRReview:
    observation_id: int
    capture_id: int
    sequence: int
    text: str
    confidence: float | None
    source: str
    speaker_candidate: str | None
    status: str
    corrected_text: str | None
    corrected_speaker: str | None
    note: str
    reviewed_at: str | None
    created_at: str
    updated_at: str | None

    @property
    def effective_text(self) -> str | None:
        if self.status == "rejected":
            return None
        if self.status == "corrected" and self.corrected_text:
            return self.corrected_text
        return self.text


@dataclass(frozen=True)
class OCRReviewResult:
    review: OCRReview
    action: str
    capture_text_changed: bool


def list_ocr_reviews(
    db_path: Path | str,
    *,
    status: str = "pending",
    max_confidence: float | None = 0.75,
    limit: int = 50,
) -> list[OCRReview]:
    """List pending or completed OCR reviews in capture/visual order."""

    if status not in ("pending", *REVIEW_STATUSES):
        raise OCRReviewError(f"unknown OCR review status: {status}")
    if max_confidence is not None and not 0 <= float(max_confidence) <= 1:
        raise OCRReviewError("max_confidence must be between 0 and 1")
    init_db(db_path)
    clauses: list[str] = []
    params: list[Any] = []
    if status == "pending":
        clauses.append("r.id is null")
    else:
        clauses.append("r.status = ?")
        params.append(status)
    if max_confidence is not None:
        clauses.append("(o.confidence is null or o.confidence <= ?)")
        params.append(float(max_confidence))
    query = """
        select
            o.id as observation_id,
            o.capture_id,
            o.sequence,
            o.text,
            o.confidence,
            o.source,
            o.speaker_candidate,
            coalesce(r.status, 'pending') as status,
            r.corrected_text,
            r.corrected_speaker,
            coalesce(r.note, '') as note,
            r.reviewed_at,
            o.created_at,
            r.updated_at
        from ocr_observations o
        left join ocr_reviews r on r.observation_id = o.id
    """
    query += " where " + " and ".join(clauses)
    query += " order by o.capture_id desc, o.sequence asc limit ?"
    params.append(max(1, min(500, int(limit))))
    with connect(db_path) as conn:
        rows = conn.execute(query, params).fetchall()
    return [_review_from_row(row) for row in rows]


def get_ocr_review(db_path: Path | str, observation_id: int) -> OCRReview | None:
    init_db(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            """
            select
                o.id as observation_id,
                o.capture_id,
                o.sequence,
                o.text,
                o.confidence,
                o.source,
                o.speaker_candidate,
                coalesce(r.status, 'pending') as status,
                r.corrected_text,
                r.corrected_speaker,
                coalesce(r.note, '') as note,
                r.reviewed_at,
                o.created_at,
                r.updated_at
            from ocr_observations o
            left join ocr_reviews r on r.observation_id = o.id
            where o.id = ?
            """,
            (int(observation_id),),
        ).fetchone()
    return _review_from_row(row) if row else None


def record_ocr_review(
    db_path: Path | str,
    *,
    observation_id: int,
    action: str,
    corrected_text: str | None = None,
    corrected_speaker: str | None = None,
    note: str = "",
    confirmed: bool = False,
    confirmation_text: str | None = None,
    reviewed_at: str | None = None,
) -> OCRReviewResult:
    """Persist one user-confirmed OCR review and rebuild effective capture text."""

    if action not in REVIEW_ACTIONS:
        raise OCRReviewError(f"action must be one of: {', '.join(REVIEW_ACTIONS)}")
    if not confirmed or confirmation_text != REVIEW_CONFIRMATION_TEXT:
        raise OCRReviewError(
            f"OCR review requires confirmed=true and confirmation_text={REVIEW_CONFIRMATION_TEXT!r}"
        )
    corrected = (corrected_text or "").strip() or None
    speaker = (corrected_speaker or "").strip() or None
    if action == "correct" and not corrected:
        raise OCRReviewError("correct action requires corrected_text")
    if action != "correct" and corrected:
        raise OCRReviewError("corrected_text is only valid with action=correct")
    if action != "correct" and speaker:
        raise OCRReviewError("corrected_speaker is only valid with action=correct")

    init_db(db_path)
    reviewed_at = reviewed_at or now_iso()
    status = {"accept": "accepted", "reject": "rejected", "correct": "corrected"}[action]
    with connect(db_path) as conn:
        observation = conn.execute(
            "select id, capture_id from ocr_observations where id = ?",
            (int(observation_id),),
        ).fetchone()
        if observation is None:
            raise OCRReviewError(f"unknown OCR observation: {observation_id}")
        created_at = now_iso()
        conn.execute(
            """
            insert into ocr_reviews
                (observation_id, status, corrected_text, corrected_speaker, note,
                 reviewed_at, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(observation_id) do update set
                status = excluded.status,
                corrected_text = excluded.corrected_text,
                corrected_speaker = excluded.corrected_speaker,
                note = excluded.note,
                reviewed_at = excluded.reviewed_at,
                updated_at = excluded.updated_at
            """,
            (
                int(observation_id),
                status,
                corrected,
                speaker,
                str(note or "").strip(),
                reviewed_at,
                created_at,
                created_at,
            ),
        )
        conn.execute(
            """
            insert into ocr_review_events
                (observation_id, action, corrected_text, corrected_speaker, note, created_at)
            values (?, ?, ?, ?, ?, ?)
            """,
            (int(observation_id), action, corrected, speaker, str(note or "").strip(), reviewed_at),
        )
        changed = _rebuild_capture_text(conn, int(observation["capture_id"]))
        row = conn.execute(
            """
            select
                o.id as observation_id,
                o.capture_id,
                o.sequence,
                o.text,
                o.confidence,
                o.source,
                o.speaker_candidate,
                coalesce(r.status, 'pending') as status,
                r.corrected_text,
                r.corrected_speaker,
                coalesce(r.note, '') as note,
                r.reviewed_at,
                o.created_at,
                r.updated_at
            from ocr_observations o
            left join ocr_reviews r on r.observation_id = o.id
            where o.id = ?
            """,
            (int(observation_id),),
        ).fetchone()
        conn.commit()
    assert row is not None
    return OCRReviewResult(
        review=_review_from_row(row),
        action=action,
        capture_text_changed=changed,
    )


def review_to_dict(review: OCRReview) -> dict[str, Any]:
    return {
        "observation_id": review.observation_id,
        "capture_id": review.capture_id,
        "sequence": review.sequence,
        "text": review.text,
        "effective_text": review.effective_text,
        "confidence": review.confidence,
        "source": review.source,
        "speaker_candidate": review.speaker_candidate,
        "status": review.status,
        "corrected_text": review.corrected_text,
        "corrected_speaker": review.corrected_speaker,
        "note": review.note,
        "reviewed_at": review.reviewed_at,
        "created_at": review.created_at,
        "updated_at": review.updated_at,
    }


def render_ocr_reviews(reviews: list[OCRReview], *, status: str, max_confidence: float | None) -> str:
    threshold = "any" if max_confidence is None else f"<={max_confidence:.2f}"
    lines = ["# OCR 校正队列", "", f"- 状态：{status}", f"- 置信度：{threshold}", ""]
    if not reviews:
        lines.append("暂无待校正 OCR observation。")
        return "\n".join(lines) + "\n"
    for review in reviews:
        confidence = "-" if review.confidence is None else f"{review.confidence:.2f}"
        lines.extend(
            [
                f"## observation {review.observation_id} / capture {review.capture_id}",
                "",
                f"- 原文：{review.text}",
                f"- 置信度：{confidence}",
                f"- 状态：{review.status}",
            ]
        )
        if review.effective_text != review.text:
            lines.append(f"- 生效文本：{review.effective_text or '（已排除）'}")
        if review.speaker_candidate:
            lines.append(f"- speaker 候选：{review.speaker_candidate}")
        if review.corrected_speaker:
            lines.append(f"- 修正 speaker：{review.corrected_speaker}")
        if review.note:
            lines.append(f"- 备注：{review.note}")
        lines.append("")
    return "\n".join(lines)


def _review_from_row(row: sqlite3.Row) -> OCRReview:
    return OCRReview(
        observation_id=int(row["observation_id"]),
        capture_id=int(row["capture_id"]),
        sequence=int(row["sequence"]),
        text=str(row["text"]),
        confidence=float(row["confidence"]) if row["confidence"] is not None else None,
        source=str(row["source"]),
        speaker_candidate=row["speaker_candidate"],
        status=str(row["status"]),
        corrected_text=row["corrected_text"],
        corrected_speaker=row["corrected_speaker"],
        note=str(row["note"] or ""),
        reviewed_at=row["reviewed_at"],
        created_at=str(row["created_at"]),
        updated_at=row["updated_at"],
    )


def _rebuild_capture_text(conn: sqlite3.Connection, capture_id: int) -> bool:
    capture = conn.execute(
        "select clean_text, corrected_text from captures where id = ?",
        (capture_id,),
    ).fetchone()
    if capture is None:
        raise OCRReviewError(f"unknown capture: {capture_id}")
    base_lines = {
        line.strip()
        for line in str(capture["clean_text"]).splitlines()
        if line.strip()
    }
    rows = conn.execute(
        """
        select o.text, coalesce(r.status, 'pending') as status,
               r.corrected_text
        from ocr_observations o
        left join ocr_reviews r on r.observation_id = o.id
        where o.capture_id = ?
        order by o.sequence
        """,
        (capture_id,),
    ).fetchall()
    lines: list[str] = []
    for row in rows:
        status = str(row["status"])
        if status == "rejected":
            continue
        text = row["corrected_text"] if status == "corrected" else row["text"]
        # ``parse_capture`` deliberately removes contact/group header lines
        # and obvious OCR noise from ``clean_text``. Keep those raw lines out
        # of the reviewed analysis unless the user explicitly corrects or
        # accepts them.
        if status == "pending" and str(row["text"] or "").strip() not in base_lines:
            continue
        if status == "accepted" and str(row["text"] or "").strip() not in base_lines:
            # An explicit accept is a user instruction to retain the line.
            text = row["text"]
        if str(text or "").strip():
            lines.append(str(text).strip())
    effective = "\n".join(lines).strip()
    corrected_text = effective if effective != str(capture["clean_text"]) else None
    previous = capture["corrected_text"]
    conn.execute("update captures set corrected_text = ? where id = ?", (corrected_text, capture_id))
    conn.execute("delete from capture_signals where capture_id = ?", (capture_id,))
    _insert_review_signals(conn, capture_id, effective)
    return previous != corrected_text


def _insert_review_signals(conn: sqlite3.Connection, capture_id: int, text: str) -> None:
    signals = extract_signals(text)
    conn.executemany(
        "insert or ignore into capture_signals (capture_id, kind, phrase) values (?, ?, ?)",
        ((capture_id, signal.kind, signal.phrase) for signal in signals),
    )
