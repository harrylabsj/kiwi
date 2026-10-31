from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3

from .parser import Signal, extract_signals, parse_capture
from .observations import OCRObservation, normalize_observations


class EmptyCaptureError(ValueError):
    pass


class DatabaseMigrationError(RuntimeError):
    """Raised when a database is newer than the running WSA schema."""

_AUTO_INTERACTION = object()
SCHEMA_VERSION = 2


SCHEMA = """
create table if not exists schema_migrations (
    version integer primary key,
    applied_at text not null
);

create table if not exists people (
    id integer primary key autoincrement,
    name text not null unique,
    aliases_json text not null default '[]',
    notes text not null default '',
    created_at text not null,
    updated_at text not null,
    last_interaction_at text
);

create table if not exists captures (
    id integer primary key autoincrement,
    person_id integer not null references people(id) on delete cascade,
    captured_at text not null,
    source text not null,
    raw_text text not null,
    clean_text text not null,
    corrected_text text,
    text_hash text not null,
    image_path text,
    image_managed integer not null default 0,
    created_at text not null,
    unique(person_id, text_hash)
);

create table if not exists capture_signals (
    id integer primary key autoincrement,
    capture_id integer not null references captures(id) on delete cascade,
    kind text not null,
    phrase text not null,
    unique(capture_id, kind)
);

create table if not exists ocr_observations (
    id integer primary key autoincrement,
    capture_id integer not null references captures(id) on delete cascade,
    sequence integer not null,
    text text not null,
    confidence real,
    bbox_x real,
    bbox_y real,
    bbox_width real,
    bbox_height real,
    source text not null default 'text',
    speaker_candidate text,
    speaker_confidence real,
    created_at text not null,
    unique(capture_id, sequence)
);

create table if not exists ocr_reviews (
    id integer primary key autoincrement,
    observation_id integer not null unique references ocr_observations(id) on delete cascade,
    status text not null check(status in ('accepted', 'rejected', 'corrected')),
    corrected_text text,
    corrected_speaker text,
    note text not null default '',
    reviewed_at text not null,
    created_at text not null,
    updated_at text not null
);

create table if not exists ocr_review_events (
    id integer primary key autoincrement,
    observation_id integer not null references ocr_observations(id) on delete cascade,
    action text not null check(action in ('accept', 'reject', 'correct')),
    corrected_text text,
    corrected_speaker text,
    note text not null default '',
    created_at text not null
);

create table if not exists contact_feedback (
    id integer primary key autoincrement,
    person_name text not null,
    action text not null,
    note text not null default '',
    until_at text,
    created_at text not null
);

create table if not exists relationship_candidates (
    id integer primary key autoincrement,
    name text not null,
    source_chat text not null,
    status text not null default 'pending',
    confidence integer not null,
    reasons_json text not null default '[]',
    evidence_captured_at text,
    evidence_excerpt text not null default '',
    icebreaker_draft text not null default '',
    created_at text not null,
    updated_at text not null,
    confirmed_at text,
    dismissed_at text,
    note text not null default '',
    unique(name, source_chat)
);

create table if not exists contact_enrichments (
    id integer primary key autoincrement,
    person_name text not null unique,
    source text not null default 'obsidian',
    fields_json text not null default '{}',
    raw_text text not null default '',
    file_path text,
    imported_at text not null,
    updated_at text not null
);

create table if not exists relationship_sources (
    id integer primary key autoincrement,
    person_name text not null,
    source_type text not null,
    title text not null default '',
    occurred_at text,
    summary text not null default '',
    fields_json text not null default '{}',
    raw_text text not null default '',
    file_path text,
    text_hash text not null,
    imported_at text not null,
    created_at text not null,
    updated_at text not null
);

create index if not exists idx_people_last_interaction
on people(last_interaction_at);

create index if not exists idx_captures_person_time
on captures(person_id, captured_at);

create index if not exists idx_ocr_observations_capture_sequence
on ocr_observations(capture_id, sequence);

create index if not exists idx_ocr_observations_speaker
on ocr_observations(speaker_candidate, speaker_confidence);

create index if not exists idx_ocr_reviews_status
on ocr_reviews(status, reviewed_at);

create index if not exists idx_ocr_review_events_observation
on ocr_review_events(observation_id, created_at);

create index if not exists idx_contact_feedback_person_time
on contact_feedback(person_name, created_at);

create index if not exists idx_relationship_candidates_status_confidence
on relationship_candidates(status, confidence);

create index if not exists idx_contact_enrichments_person
on contact_enrichments(person_name);

create index if not exists idx_relationship_sources_person_time
on relationship_sources(person_name, occurred_at);

create index if not exists idx_relationship_sources_type_time
on relationship_sources(source_type, occurred_at);

create unique index if not exists idx_relationship_sources_unique
on relationship_sources(person_name, source_type, title, ifnull(occurred_at, ''), text_hash);
"""


@dataclass(frozen=True)
class IngestResult:
    capture_id: int
    person_id: int
    contact_name: str
    inserted: bool
    text_hash: str
    signal_kinds: tuple[str, ...]
    image_attached: bool = False


@dataclass(frozen=True)
class ResetResult:
    db_path: Path
    captures_dir: Path
    removed_people: int
    removed_captures: int
    removed_signals: int
    removed_feedback: int
    removed_candidates: int
    removed_enrichments: int
    removed_sources: int
    removed_screenshots: int
    dry_run: bool = False


@dataclass(frozen=True)
class RefreshSignalsResult:
    capture_count: int
    signal_count: int


@dataclass(frozen=True)
class RefreshDerivedPeopleResult:
    capture_count: int


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def default_db_path(root: Path | None = None) -> Path:
    base = root or Path.cwd()
    return base / "data" / "social.db"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def backup_database(
    db_path: Path | str,
    backup_path: Path | str,
    *,
    overwrite: bool = False,
) -> Path:
    """Create a consistent SQLite backup without copying a live WAL file."""

    source = Path(db_path).expanduser().resolve(strict=False)
    target = Path(backup_path).expanduser().resolve(strict=False)
    if not source.exists():
        raise FileNotFoundError(f"database does not exist: {source}")
    if source == target:
        raise ValueError("backup path must differ from the source database")
    if target.exists() and not overwrite:
        raise FileExistsError(f"backup already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source, timeout=5.0) as source_conn:
        with sqlite3.connect(target, timeout=5.0) as target_conn:
            source_conn.backup(target_conn)
    return target


def schema_version(db_path: Path | str) -> int:
    """Return the applied schema version, initializing an empty database first."""

    init_db(db_path)
    with connect(db_path) as conn:
        row = conn.execute("select coalesce(max(version), 0) from schema_migrations").fetchone()
    return int(row[0] if row else 0)


def connect(db_path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(Path(db_path), timeout=5.0, factory=ClosingConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma foreign_keys = on")
    conn.execute("pragma busy_timeout = 5000")
    try:
        conn.execute("pragma journal_mode = wal")
        conn.execute("pragma synchronous = normal")
    except sqlite3.DatabaseError:
        # Read-only snapshots and some virtual filesystems do not permit
        # changing journal mode. The connection remains usable in that case.
        pass
    return conn


def init_db(db_path: Path | str) -> None:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as conn:
        conn.executescript(SCHEMA)
        _apply_schema_migrations(conn)
        conn.commit()


def ingest_capture(
    db_path: Path | str,
    *,
    raw_text: str,
    contact_hint: str | None = None,
    source: str = "ocr",
    captured_at: str | None = None,
    image_path: str | None = None,
    image_managed: bool | None = None,
    interaction_at: str | None | object = _AUTO_INTERACTION,
    observations: list[OCRObservation] | tuple[OCRObservation, ...] | None = None,
) -> IngestResult:
    init_db(db_path)
    captured_at = captured_at or now_iso()
    if interaction_at is _AUTO_INTERACTION:
        interaction_at = captured_at
    parsed = parse_capture(raw_text, contact_hint=contact_hint)
    if not parsed.clean_text.strip():
        raise EmptyCaptureError("empty capture text after OCR cleanup")
    if image_managed is None:
        image_managed = _is_managed_capture_path(db_path, image_path)
    normalized_observations = _prepare_observations(
        observations,
        parsed_lines=parsed.lines,
        source=source,
        chat_name=parsed.contact_name,
    )
    text_hash = _hash_text(parsed.clean_text)
    current_time = now_iso()

    with connect(db_path) as conn:
        person_id = _ensure_person(conn, parsed.contact_name, current_time)
        existing = conn.execute(
            "select id, image_path, image_managed from captures where person_id = ? and text_hash = ?",
            (person_id, text_hash),
        ).fetchone()
        if existing:
            image_attached = False
            if image_path and _should_attach_duplicate_image(existing["image_path"]):
                conn.execute(
                    """
                    update captures
                    set image_path = ?,
                        captured_at = ?,
                        source = ?,
                        raw_text = ?,
                        image_managed = ?,
                        created_at = ?
                    where id = ?
                    """,
                    (image_path, captured_at, source, raw_text, int(bool(image_managed)), current_time, int(existing["id"])),
                )
                image_attached = True
            if image_attached:
                _touch_person_interaction(conn, person_id, interaction_at, current_time)
            _insert_capture_signals(conn, int(existing["id"]), parsed.signals)
            _insert_ocr_observations(conn, int(existing["id"]), normalized_observations, current_time)
            _ensure_group_speakers(conn, parsed.contact_name, parsed.lines, interaction_at, current_time)
            conn.commit()
            return IngestResult(
                capture_id=int(existing["id"]),
                person_id=person_id,
                contact_name=parsed.contact_name,
                inserted=False,
                text_hash=text_hash,
                signal_kinds=tuple(signal.kind for signal in parsed.signals),
                image_attached=image_attached,
            )

        cursor = conn.execute(
            """
            insert into captures
            (person_id, captured_at, source, raw_text, clean_text, text_hash, image_path, image_managed, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                person_id,
                captured_at,
                source,
                raw_text,
                parsed.clean_text,
                text_hash,
                image_path,
                int(bool(image_managed)),
                current_time,
            ),
        )
        capture_id = int(cursor.lastrowid)
        _insert_capture_signals(conn, capture_id, parsed.signals)
        _insert_ocr_observations(conn, capture_id, normalized_observations, current_time)
        _touch_person_interaction(conn, person_id, interaction_at, current_time)
        _ensure_group_speakers(conn, parsed.contact_name, parsed.lines, interaction_at, current_time)
        conn.commit()

    return IngestResult(
        capture_id=capture_id,
        person_id=person_id,
        contact_name=parsed.contact_name,
        inserted=True,
        text_hash=text_hash,
        signal_kinds=tuple(signal.kind for signal in parsed.signals),
    )


def reset_memory(
    db_path: Path | str,
    *,
    captures_dir: Path | str | None = None,
    dry_run: bool = False,
) -> ResetResult:
    db = Path(db_path)
    screenshots = Path(captures_dir) if captures_dir is not None else db.parent / "captures"
    init_db(db)

    with connect(db) as conn:
        removed_people = int(conn.execute("select count(*) from people").fetchone()[0])
        removed_captures = int(conn.execute("select count(*) from captures").fetchone()[0])
        removed_signals = int(conn.execute("select count(*) from capture_signals").fetchone()[0])
        removed_feedback = int(conn.execute("select count(*) from contact_feedback").fetchone()[0])
        removed_candidates = int(conn.execute("select count(*) from relationship_candidates").fetchone()[0])
        removed_enrichments = int(conn.execute("select count(*) from contact_enrichments").fetchone()[0])
        removed_sources = int(conn.execute("select count(*) from relationship_sources").fetchone()[0])
        if not dry_run:
            conn.execute("delete from capture_signals")
            conn.execute("delete from captures")
            conn.execute("delete from people")
            conn.execute("delete from contact_feedback")
            conn.execute("delete from relationship_candidates")
            conn.execute("delete from contact_enrichments")
            conn.execute("delete from relationship_sources")
            conn.commit()

    screenshot_files = _screenshot_files(screenshots)
    if not dry_run:
        for path in screenshot_files:
            path.unlink(missing_ok=True)

    return ResetResult(
        db_path=db,
        captures_dir=screenshots,
        removed_people=removed_people,
        removed_captures=removed_captures,
        removed_signals=removed_signals,
        removed_feedback=removed_feedback,
        removed_candidates=removed_candidates,
        removed_enrichments=removed_enrichments,
        removed_sources=removed_sources,
        removed_screenshots=len(screenshot_files),
        dry_run=dry_run,
    )


def refresh_capture_signals(db_path: Path | str) -> RefreshSignalsResult:
    init_db(db_path)
    with connect(db_path) as conn:
        captures = conn.execute(
            "select id, coalesce(corrected_text, clean_text) as effective_text from captures order by id"
        ).fetchall()
        conn.execute("delete from capture_signals")
        signal_count = 0
        for capture in captures:
            signals = extract_signals(capture["effective_text"])
            _insert_capture_signals(conn, int(capture["id"]), signals)
            signal_count += len(signals)
        conn.commit()

    return RefreshSignalsResult(capture_count=len(captures), signal_count=signal_count)


def list_ocr_observations(
    db_path: Path | str,
    *,
    capture_id: int | None = None,
    limit: int | None = None,
) -> list[OCRObservation]:
    """Read structured OCR observations for a capture or the whole database."""

    init_db(db_path)
    clauses: list[str] = []
    params: list[object] = []
    if capture_id is not None:
        clauses.append("capture_id = ?")
        params.append(int(capture_id))
    query = "select * from ocr_observations"
    if clauses:
        query += " where " + " and ".join(clauses)
    query += " order by capture_id, sequence"
    if limit is not None:
        query += " limit ?"
        params.append(max(1, int(limit)))
    with connect(db_path) as conn:
        rows = conn.execute(query, params).fetchall()
    return [
        OCRObservation(
            text=row["text"],
            confidence=row["confidence"],
            bbox_x=row["bbox_x"],
            bbox_y=row["bbox_y"],
            bbox_width=row["bbox_width"],
            bbox_height=row["bbox_height"],
            source=row["source"],
            speaker_candidate=row["speaker_candidate"],
            speaker_confidence=row["speaker_confidence"],
            sequence=row["sequence"],
        )
        for row in rows
    ]


def refresh_derived_people(db_path: Path | str) -> RefreshDerivedPeopleResult:
    init_db(db_path)
    current_time = now_iso()
    with connect(db_path) as conn:
        captures = conn.execute(
            """
            select p.name as chat_name,
                   coalesce(c.corrected_text, c.clean_text) as effective_text,
                   c.captured_at
            from captures c
            join people p on p.id = c.person_id
            order by c.captured_at asc, c.id asc
            """
        ).fetchall()
        for capture in captures:
            lines = [line.strip() for line in capture["effective_text"].splitlines() if line.strip()]
            _ensure_group_speakers(
                conn,
                capture["chat_name"],
                lines,
                # Rebuilding derived people is deterministic: retain the
                # observation timestamp from the source capture, never the
                # time at which ``analyze`` happens to run.
                capture["captured_at"],
                current_time,
            )
        conn.commit()

    return RefreshDerivedPeopleResult(capture_count=len(captures))


def _ensure_person(
    conn: sqlite3.Connection,
    name: str,
    current_time: str,
) -> int:
    existing = conn.execute("select id from people where name = ?", (name,)).fetchone()
    if existing:
        return int(existing["id"])

    cursor = conn.execute(
        """
        insert into people
        (name, aliases_json, notes, created_at, updated_at, last_interaction_at)
        values (?, ?, '', ?, ?, ?)
        """,
        (name, json.dumps([], ensure_ascii=False), current_time, current_time, None),
    )
    return int(cursor.lastrowid)


def _touch_person_interaction(
    conn: sqlite3.Connection,
    person_id: int,
    interaction_at: str | None | object,
    current_time: str,
) -> None:
    if interaction_at is None:
        conn.execute("update people set updated_at = ? where id = ?", (current_time, person_id))
        return
    conn.execute(
        """
        update people
        set updated_at = ?,
            last_interaction_at = case
                when last_interaction_at is null or last_interaction_at < ? then ?
                else last_interaction_at
            end
        where id = ?
        """,
        (current_time, interaction_at, interaction_at, person_id),
    )


def _should_attach_duplicate_image(existing_image_path: str | None) -> bool:
    if not existing_image_path:
        return True
    return not Path(existing_image_path).exists()


def _apply_schema_migrations(conn: sqlite3.Connection) -> None:
    """Apply idempotent, ordered migrations to both old and new databases."""

    conn.execute(
        """
        create table if not exists schema_migrations (
            version integer primary key,
            applied_at text not null
        )
        """
    )
    current_row = conn.execute("select coalesce(max(version), 0) from schema_migrations").fetchone()
    current = int(current_row[0] if current_row else 0)
    if current > SCHEMA_VERSION:
        raise DatabaseMigrationError(
            f"database schema version {current} is newer than supported {SCHEMA_VERSION}"
        )
    migrations = {
        1: _migration_v1_structured_ocr,
        2: _migration_v2_ocr_reviews,
    }
    for version in range(current + 1, SCHEMA_VERSION + 1):
        migrations[version](conn)
        conn.execute(
            "insert into schema_migrations(version, applied_at) values (?, ?)",
            (version, now_iso()),
        )


def _migration_v1_structured_ocr(conn: sqlite3.Connection) -> None:
    _ensure_column(conn, "captures", "image_path", "text")
    _ensure_column(conn, "captures", "image_managed", "integer not null default 0")
    conn.executescript(
        """
        create table if not exists ocr_observations (
            id integer primary key autoincrement,
            capture_id integer not null references captures(id) on delete cascade,
            sequence integer not null,
            text text not null,
            confidence real,
            bbox_x real,
            bbox_y real,
            bbox_width real,
            bbox_height real,
            source text not null default 'text',
            speaker_candidate text,
            speaker_confidence real,
            created_at text not null,
            unique(capture_id, sequence)
        );
        create index if not exists idx_ocr_observations_capture_sequence
        on ocr_observations(capture_id, sequence);
        create index if not exists idx_ocr_observations_speaker
        on ocr_observations(speaker_candidate, speaker_confidence);
        """
    )
    _backfill_ocr_observations(conn)


def _migration_v2_ocr_reviews(conn: sqlite3.Connection) -> None:
    _ensure_column(conn, "captures", "corrected_text", "text")
    conn.executescript(
        """
        create table if not exists ocr_reviews (
            id integer primary key autoincrement,
            observation_id integer not null unique references ocr_observations(id) on delete cascade,
            status text not null check(status in ('accepted', 'rejected', 'corrected')),
            corrected_text text,
            corrected_speaker text,
            note text not null default '',
            reviewed_at text not null,
            created_at text not null,
            updated_at text not null
        );
        create table if not exists ocr_review_events (
            id integer primary key autoincrement,
            observation_id integer not null references ocr_observations(id) on delete cascade,
            action text not null check(action in ('accept', 'reject', 'correct')),
            corrected_text text,
            corrected_speaker text,
            note text not null default '',
            created_at text not null
        );
        create index if not exists idx_ocr_reviews_status
        on ocr_reviews(status, reviewed_at);
        create index if not exists idx_ocr_review_events_observation
        on ocr_review_events(observation_id, created_at);
        """
    )


def _backfill_ocr_observations(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        select c.id, c.clean_text, c.source, p.name as chat_name
        from captures c
        join people p on p.id = c.person_id
        where not exists (
            select 1 from ocr_observations o where o.capture_id = c.id
        )
        order by c.id
        """
    ).fetchall()
    for row in rows:
        observations = _prepare_observations(
            None,
            parsed_lines=[line for line in str(row["clean_text"]).splitlines() if line.strip()],
            source=str(row["source"] or "text"),
            chat_name=str(row["chat_name"] or ""),
        )
        _insert_ocr_observations(conn, int(row["id"]), observations, now_iso())


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in conn.execute(f"pragma table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"alter table {table} add column {column} {definition}")


def _ensure_group_speakers(
    conn: sqlite3.Connection,
    chat_name: str,
    lines: list[str],
    interaction_at: str | None | object,
    current_time: str,
) -> None:
    from .profiles import extract_speakers

    for speaker in extract_speakers(lines, chat_name=chat_name):
        speaker_id = _ensure_person(conn, speaker, current_time)
        _touch_person_interaction(conn, speaker_id, interaction_at, current_time)


def _insert_capture_signals(conn: sqlite3.Connection, capture_id: int, signals: list[Signal]) -> None:
    conn.executemany(
        "insert or ignore into capture_signals (capture_id, kind, phrase) values (?, ?, ?)",
        ((capture_id, signal.kind, signal.phrase) for signal in signals),
    )


def _prepare_observations(
    observations: list[OCRObservation] | tuple[OCRObservation, ...] | None,
    *,
    parsed_lines: list[str],
    source: str,
    chat_name: str,
) -> tuple[OCRObservation, ...]:
    normalized = normalize_observations(observations, fallback_text=parsed_lines, source=source)
    if not normalized:
        return normalized
    # Keep the spatial observation as the source of truth, then add only a
    # low-confidence heuristic speaker candidate. This is deliberately not a
    # confirmed identity; profiles/candidates still apply their own guards.
    from .profiles import annotate_speaker_candidates

    return annotate_speaker_candidates(normalized, chat_name=chat_name)


def _insert_ocr_observations(
    conn: sqlite3.Connection,
    capture_id: int,
    observations: tuple[OCRObservation, ...],
    current_time: str,
) -> None:
    conn.executemany(
        """
        insert or ignore into ocr_observations
        (capture_id, sequence, text, confidence, bbox_x, bbox_y, bbox_width,
         bbox_height, source, speaker_candidate, speaker_confidence, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                capture_id,
                int(observation.sequence if observation.sequence is not None else index),
                observation.text,
                observation.confidence,
                observation.bbox_x,
                observation.bbox_y,
                observation.bbox_width,
                observation.bbox_height,
                observation.source,
                observation.speaker_candidate,
                observation.speaker_confidence,
                current_time,
            )
            for index, observation in enumerate(observations)
        ),
    )


def _hash_text(text: str) -> str:
    stable = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    return hashlib.sha256(stable.encode("utf-8")).hexdigest()


def _screenshot_files(path: Path) -> list[Path]:
    if not path.exists():
        return []
    suffixes = {".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff"}
    return sorted(item for item in path.iterdir() if item.is_file() and item.suffix.lower() in suffixes)


def _is_managed_capture_path(db_path: Path | str, image_path: str | None) -> bool:
    if not image_path:
        return False
    try:
        candidate = Path(image_path).expanduser().resolve(strict=False)
        root = (Path(db_path).expanduser().resolve(strict=False).parent / "captures").resolve(strict=False)
        candidate.relative_to(root)
    except (OSError, ValueError):
        return False
    return True
