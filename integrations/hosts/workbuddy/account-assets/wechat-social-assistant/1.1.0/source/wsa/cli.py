from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
import re
import sqlite3
import sys
import time

from .audit import (
    build_audit_report,
    delete_contact_data,
    export_local_data,
    render_audit_report_markdown,
)
from .candidates import (
    confirm_relationship_candidate,
    discover_relationship_candidates,
    render_candidates_markdown,
    sync_relationship_candidates,
)
from .connectors import connector_statuses
from .dashboard import build_relationship_dashboard, render_relationship_dashboard_markdown
from .enrichment import (
    ContactEnrichment,
    ENRICHMENT_FIELDS,
    enrichment_by_person,
    enrichment_summary,
    list_contact_enrichments,
)
from .feedback import FEEDBACK_ACTIONS, list_feedback, record_feedback, render_feedback_markdown
from .ocr import CaptureError, capture_screenshot, frontmost_app_status, next_capture_path, ocr_image
from .obsidian_memory import import_obsidian_enrichments
from .profiles import build_profiles, extract_speakers, render_profiles_markdown, signal_label
from .relationship_quality import build_relationship_quality_cards, render_relationship_quality_markdown
from .reviews import (
    REVIEW_CONFIRMATION_TEXT,
    REVIEW_STATUSES,
    OCRReviewError,
    list_ocr_reviews,
    record_ocr_review,
    render_ocr_reviews,
)
from .sources import (
    SOURCE_TYPES,
    import_relationship_sources,
    list_relationship_sources,
    render_relationship_sources_markdown,
)
from .settings import load_settings, save_watch_interval, settings_path_for_db
from .status import build_status_report, render_status_report, status_quality_notes, stop_watch_processes
from .store import (
    EmptyCaptureError,
    connect,
    backup_database,
    default_db_path,
    ingest_capture,
    init_db,
    now_iso,
    refresh_capture_signals,
    refresh_derived_people,
    reset_memory,
    schema_version,
)
from .suggestions import build_suggestions, followup_strength_label, render_markdown
from .timefmt import format_display_time
from .wechat_archive import (
    default_wechat_archive_manifest,
    delete_wechat_archive_sources,
    import_wechat_archive_manifest,
    render_wechat_archive_import_markdown,
)


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff"}
DEFAULT_OBSIDIAN_VAULT = Path.home() / "Documents" / "Obsidian Vault"


def _default_reports_dir(db_path: Path) -> Path:
    db_parent = db_path.parent
    if db_parent.name == "data":
        return db_parent.parent / "reports"
    return db_parent / "reports"


def _default_backup_path(db_path: Path) -> Path:
    stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    return Path(db_path).parent / "backups" / f"social-{stamp}.db"


class WSAArgumentParser(argparse.ArgumentParser):
    def parse_args(self, args: list[str] | None = None, namespace: argparse.Namespace | None = None):
        parsed = super().parse_args(args, namespace)
        if getattr(parsed, "command", None) in {"analyze", "status", "watch", "weekly-report"} and parsed.log_file is None:
            parsed.log_file = Path(parsed.db).parent / "watch.log"
        if getattr(parsed, "command", None) == "watch" and parsed.app is None:
            parsed.app = ["WeChat", "微信"]
        if getattr(parsed, "command", None) == "analyze":
            reports_dir = _default_reports_dir(Path(parsed.db))
            if parsed.profiles_out is None:
                parsed.profiles_out = reports_dir / "contact-profiles.md"
            if parsed.suggestions_out is None:
                parsed.suggestions_out = reports_dir / "outreach.md"
        return parsed


@dataclass
class WatchLogState:
    last_key: tuple[str, str, str] | None = None
    repeat_count: int = 0


@dataclass(frozen=True)
class BriefEvidence:
    chat_name: str
    captured_at: str
    source: str
    image_path: str | None


@dataclass(frozen=True)
class CaptureOutcome:
    output_line: str
    log_detail: str


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except CaptureError as exc:
        print(f"capture/ocr error: {exc}", file=sys.stderr)
        return 2
    except EmptyCaptureError as exc:
        print(f"ingest error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nstopped", file=sys.stderr)
        return 130


def build_parser() -> argparse.ArgumentParser:
    parser = WSAArgumentParser(
        prog="wsa",
        description="Local-first WeChat social memory assistant.",
    )
    parser.add_argument("--db", type=Path, default=default_db_path(Path.cwd()))
    sub = parser.add_subparsers(dest="command", required=True)

    init_cmd = sub.add_parser("init", help="Create the local SQLite database.")
    init_cmd.set_defaults(func=cmd_init)

    backup = sub.add_parser("backup", help="Create a consistent local SQLite backup.")
    backup.add_argument("--out", type=Path, help="Backup path. Defaults to data/backups/social-<timestamp>.db.")
    backup.add_argument("--yes", action="store_true", help="Confirm writing the backup file.")
    backup.set_defaults(func=cmd_backup)

    connectors = sub.add_parser("connectors", help="Show available capture and Accessibility connectors.")
    connectors.set_defaults(func=cmd_connectors)

    ingest = sub.add_parser("ingest", help="Ingest OCR/manual text into the relationship memory.")
    ingest.add_argument("--contact", help="Contact name hint. Recommended for early MVP use.")
    ingest.add_argument("--text", help="Text to ingest.")
    ingest.add_argument("--text-file", type=Path, help="Text file to ingest.")
    ingest.add_argument("--source", default="manual")
    ingest.add_argument("--image-path")
    ingest.set_defaults(func=cmd_ingest)

    capture = sub.add_parser("capture", help="Capture screen/window, OCR it, and ingest the text.")
    capture.add_argument("--contact", help="Contact name hint.")
    capture.add_argument("--mode", choices=["screen", "window"], default="window")
    capture.add_argument("--source", default="ocr")
    capture.add_argument("--crop", help="Crop captured image before OCR as x,y,width,height.")
    capture.add_argument("--crop-preset", choices=["none", "wechat-chat"], default="none")
    capture.set_defaults(func=cmd_capture)

    quick_capture = sub.add_parser(
        "quick-capture",
        aliases=["qc"],
        help="Immediately capture the current screen with hotkey-friendly defaults.",
    )
    quick_capture.add_argument("--contact", help="Contact name hint.")
    quick_capture.add_argument("--mode", choices=["screen", "window"], default="window")
    quick_capture.add_argument("--source", default="hotkey")
    quick_capture.add_argument("--crop", help="Crop captured image before OCR as x,y,width,height.")
    quick_capture.add_argument("--crop-preset", choices=["none", "wechat-chat"], default="none")
    quick_capture.set_defaults(func=cmd_quick_capture)

    ocr = sub.add_parser("ocr-image", help="Run OCR for an existing image.")
    ocr.add_argument("image", type=Path)
    ocr.set_defaults(func=cmd_ocr_image)

    ocr_review = sub.add_parser("ocr-review", help="Review low-confidence OCR observations.")
    ocr_review.add_argument("--status", choices=["pending", *REVIEW_STATUSES], default="pending")
    ocr_review.add_argument("--max-confidence", type=float, default=0.75)
    ocr_review.add_argument("--limit", type=int, default=50)
    ocr_review.add_argument("--observation-id", type=int, help="Observation id to review.")
    ocr_review.add_argument("--action", choices=["accept", "reject", "correct"])
    ocr_review.add_argument("--corrected-text")
    ocr_review.add_argument("--corrected-speaker")
    ocr_review.add_argument("--note", default="")
    ocr_review.add_argument("--reviewed-at")
    ocr_review.add_argument("--yes", action="store_true", help="Confirm writing the OCR review.")
    ocr_review.set_defaults(func=cmd_ocr_review)

    import_image = sub.add_parser(
        "import-image",
        aliases=["ingest-image"],
        help="OCR an existing image and ingest it as relationship evidence.",
    )
    import_image.add_argument("images", type=Path, nargs="+", metavar="image")
    import_image.add_argument("--contact", help="Contact name hint.")
    import_image.add_argument("--source", default="image")
    import_image.set_defaults(func=cmd_import_image)

    suggest = sub.add_parser("suggest", help="Generate a Markdown outreach plan.")
    suggest.add_argument("--limit", type=int, default=20)
    suggest.add_argument("--min-score", type=int, default=45, help="Only include suggestions with score >= N.")
    suggest.add_argument("--contact", help="Only include suggestions matching this contact or source chat.")
    suggest.add_argument("--title", default="社交跟进建议")
    suggest.add_argument("--as-of", help="Analysis timestamp for recency scoring. Defaults to now.")
    suggest.add_argument("--out", type=Path)
    suggest.set_defaults(func=cmd_suggest)

    next_cmd = sub.add_parser("next", help="Print the single highest-priority follow-up draft.")
    next_cmd.add_argument("--min-score", type=int, default=45, help="Only show a suggestion with score >= N.")
    next_cmd.add_argument("--contact", help="Only search suggestions matching this contact or source chat.")
    next_cmd.add_argument("--as-of", help="Analysis timestamp for recency scoring. Defaults to now.")
    next_cmd.add_argument("--draft-only", action="store_true", help="Only print the draft text for easy copying.")
    next_cmd.set_defaults(func=cmd_next)

    contacts = sub.add_parser("contacts", help="List contact names available for --contact filters.")
    contacts.add_argument("--query", help="Filter contacts by name or source chat.")
    contacts.add_argument("--contact", help="Alias for --query, for consistency with other filtered commands.")
    contacts.add_argument("--limit", type=int)
    contacts.add_argument("--out", type=Path)
    contacts.set_defaults(func=cmd_contacts)

    brief = sub.add_parser("brief", help="Show one contact profile with the next follow-up draft.")
    brief.add_argument("query", nargs="?", help="Contact name, source group, organization, or identity hint.")
    brief.add_argument("--contact", help="Contact name, source group, organization, or identity hint.")
    brief.add_argument("--min-score", type=int, default=0, help="Only show a suggestion with score >= N.")
    brief.add_argument("--as-of", help="Analysis timestamp for recency scoring. Defaults to now.")
    brief.add_argument("--out", type=Path)
    brief.set_defaults(func=cmd_brief)

    profiles = sub.add_parser("profiles", help="Generate contact-centered relationship profiles.")
    profiles.add_argument("--contact", help="Only show profiles matching this contact or source chat.")
    profiles.add_argument("--limit", type=int)
    profiles.add_argument("--title", default="联系人关系档案")
    profiles.add_argument("--out", type=Path)
    profiles.set_defaults(func=cmd_profiles)

    quality = sub.add_parser("quality", help="Render the relationship quality operating desk.")
    quality.add_argument("--contact", help="Only include quality cards matching this contact or source chat.")
    quality.add_argument("--limit", type=int, default=20)
    quality.add_argument("--min-score", type=int, default=45, help="Only use suggestions with score >= N for next actions.")
    quality.add_argument("--as-of", help="Analysis timestamp for recency scoring. Defaults to now.")
    quality.add_argument("--out", type=Path)
    quality.set_defaults(func=cmd_quality)

    dashboard = sub.add_parser("dashboard", help="Render the daily relationship operating dashboard.")
    dashboard.add_argument("--limit", type=int, default=8)
    dashboard.add_argument("--min-score", type=int, default=45, help="Minimum follow-up score for priority contacts.")
    dashboard.add_argument("--as-of", help="Analysis timestamp for recency scoring. Defaults to now.")
    dashboard.add_argument("--out", type=Path)
    dashboard.set_defaults(func=cmd_dashboard)

    wechat_archive = sub.add_parser(
        "import-wechat-archive",
        help="Import safe relationship signals from a WeChat archive manifest TSV.",
    )
    wechat_archive.add_argument("--manifest", type=Path, default=default_wechat_archive_manifest())
    wechat_archive.add_argument("--limit", type=int, default=300)
    wechat_archive.add_argument("--min-score", type=int, default=35)
    wechat_archive.add_argument("--contact-hint", action="append", default=[])
    wechat_archive.add_argument("--include-unmatched", action="store_true", help="Also import high-value unmatched archive files.")
    wechat_archive.add_argument("--only-matched", action="store_true", help="Only import rows matched to known contacts.")
    wechat_archive.add_argument("--include-sensitive", action="store_true", help="Include high-sensitive filenames.")
    wechat_archive.add_argument("--replace", action="store_true", help="Replace existing WeChat archive source rows first.")
    wechat_archive.add_argument("--yes", action="store_true", help="Required to write imported archive sources.")
    wechat_archive.add_argument("--dry-run", action="store_true", help="Preview importable archive sources without writing.")
    wechat_archive.add_argument("--imported-at", help="Override import timestamp for tests/imports.")
    wechat_archive.add_argument("--out", type=Path)
    wechat_archive.set_defaults(func=cmd_import_wechat_archive)

    cockpit = sub.add_parser(
        "cockpit",
        help="Build the full relationship cockpit from WeChat archive, contact notes, and local memory.",
    )
    cockpit.add_argument("--vault", type=Path, default=Path.home() / "Hbrain")
    cockpit.add_argument("--wechat-manifest", type=Path, default=default_wechat_archive_manifest())
    cockpit.add_argument("--out", type=Path)
    cockpit.add_argument("--limit", type=int, default=8)
    cockpit.add_argument("--archive-limit", type=int, default=300)
    cockpit.add_argument("--min-score", type=int, default=45)
    cockpit.add_argument("--archive-min-score", type=int, default=35)
    cockpit.add_argument("--as-of", help="Analysis timestamp for recency scoring. Defaults to now.")
    cockpit.add_argument("--include-sensitive", action="store_true", help="Include high-sensitive archive filenames.")
    cockpit.add_argument("--replace-wechat-archive", action="store_true", help="Replace existing WeChat archive source rows first.")
    cockpit.add_argument("--yes", action="store_true", help="Required to import sources before rendering.")
    cockpit.add_argument("--dry-run", action="store_true", help="Preview source imports; render from current DB.")
    cockpit.add_argument("--imported-at", help="Override import timestamp for tests/imports.")
    cockpit.set_defaults(func=cmd_cockpit)

    candidates = sub.add_parser("candidates", help="Discover relationship candidates from group/event contexts.")
    candidates.add_argument("--min-confidence", type=int, default=45, help="Only include candidates with confidence >= N.")
    candidates.add_argument("--limit", type=int, default=50)
    candidates.add_argument("--status", choices=["pending", "confirmed", "dismissed"], help="Only show one lifecycle status.")
    candidates.add_argument("--sync", action="store_true", help="Persist discovered candidates into the local database.")
    candidates.add_argument("--out", type=Path)
    candidates.set_defaults(func=cmd_candidates)

    candidate_confirm = sub.add_parser(
        "candidate-confirm",
        help="Confirm a relationship candidate after user review.",
    )
    candidate_confirm.add_argument("name", nargs="?", help="Candidate name. Optional when --id is provided.")
    candidate_confirm.add_argument("--source-chat", help="Source group/event chat for the candidate.")
    candidate_confirm.add_argument("--id", type=int, dest="candidate_id", help="Candidate id.")
    candidate_confirm.add_argument("--note", default="")
    candidate_confirm.add_argument("--confirmed-at", help="Override confirmation timestamp for imports/tests.")
    candidate_confirm.add_argument("--yes", action="store_true", help="Required to write the confirmation locally.")
    candidate_confirm.set_defaults(func=cmd_candidate_confirm)

    feedback = sub.add_parser("feedback", help="Record local feedback for a contact suggestion.")
    feedback.add_argument("contact", help="Contact name.")
    feedback.add_argument("action", choices=FEEDBACK_ACTIONS)
    feedback.add_argument("--note", default="")
    feedback.add_argument("--until", dest="until_at", help="Required for snooze; ISO timestamp or date.")
    feedback.add_argument("--created-at", help="Override feedback creation time for imports/tests.")
    feedback.set_defaults(func=cmd_feedback)

    feedback_list = sub.add_parser("feedback-list", help="List local feedback records.")
    feedback_list.add_argument("--contact", help="Only list feedback for one contact.")
    feedback_list.add_argument("--limit", type=int, default=50)
    feedback_list.add_argument("--out", type=Path)
    feedback_list.set_defaults(func=cmd_feedback_list)

    status = sub.add_parser("status", help="Summarize database, screenshots, and watch log state.")
    status.add_argument("--log-file", type=Path, help="Watch debug log path. Defaults to DB directory/watch.log.")
    status.add_argument("--captures-dir", type=Path, help="Screenshot directory. Defaults to DB directory/captures.")
    status.add_argument("--as-of", help="Analysis timestamp for recency scoring. Defaults to now.")
    status.set_defaults(func=cmd_status)

    audit = sub.add_parser("audit", help="Render a local data audit report.")
    audit.add_argument("--out", type=Path)
    audit.set_defaults(func=cmd_audit)

    export_data = sub.add_parser("export-data", help="Export local database tables to a JSON file.")
    export_data.add_argument("--out", type=Path, required=True)
    export_data.add_argument("--yes", action="store_true", help="Required to write the export file.")
    export_data.set_defaults(func=cmd_export_data)

    delete_contact = sub.add_parser("delete-contact", help="Delete one contact and related local records.")
    delete_contact.add_argument("contact")
    delete_contact.add_argument("--yes", action="store_true", help="Required to delete local records.")
    delete_contact.add_argument("--dry-run", action="store_true", help="Only show what would be deleted.")
    delete_contact.set_defaults(func=cmd_delete_contact)

    stop_watch = sub.add_parser(
        "stop-watch",
        aliases=["stop"],
        help="Stop running wsa watch processes. Use --dry-run to preview.",
    )
    stop_watch.add_argument("--dry-run", action="store_true", help="Only list matching watch processes.")
    stop_watch.set_defaults(func=cmd_stop_watch)

    watch_interval = sub.add_parser(
        "watch-interval",
        aliases=["interval"],
        help="Show or set the saved default watch polling interval in seconds.",
    )
    watch_interval.add_argument("seconds", type=int, nargs="?", help="New default interval in seconds. Minimum is 5.")
    watch_interval.set_defaults(func=cmd_watch_interval)

    reset = sub.add_parser("reset", help="Clear local database rows and captured screenshots.")
    reset.add_argument("--yes", action="store_true", help="Actually clear data. Required unless --dry-run is used.")
    reset.add_argument("--dry-run", action="store_true", help="Only show what would be cleared.")
    reset.add_argument("--captures-dir", type=Path, help="Screenshot directory. Defaults to DB directory/captures.")
    reset.set_defaults(func=cmd_reset)

    analyze = sub.add_parser("analyze", help="Write status, contact profiles, and outreach suggestions in one pass.")
    analyze.add_argument("--limit", type=int, default=20)
    analyze.add_argument("--min-score", type=int, default=45, help="Only include outreach suggestions with score >= N.")
    analyze.add_argument("--contact", help="Only include profiles and suggestions matching this contact or source chat.")
    analyze.add_argument("--profiles-out", type=Path)
    analyze.add_argument("--suggestions-out", type=Path)
    analyze.add_argument("--as-of", help="Analysis timestamp for recency scoring. Defaults to now.")
    analyze.add_argument("--log-file", type=Path, help="Watch debug log path. Defaults to DB directory/watch.log.")
    analyze.add_argument("--captures-dir", type=Path, help="Screenshot directory. Defaults to DB directory/captures.")
    analyze.set_defaults(func=cmd_analyze)

    obsidian = sub.add_parser(
        "export-obsidian",
        help="Export one Markdown file per contact and one daily social report into an Obsidian vault.",
    )
    obsidian.add_argument("--vault", type=Path, default=DEFAULT_OBSIDIAN_VAULT, help="Obsidian vault root.")
    obsidian.add_argument("--date", help="Report date as YYYY-MM-DD. Defaults to today.")
    obsidian.add_argument("--as-of", help="Analysis timestamp for recency scoring. Defaults to now.")
    obsidian.add_argument("--min-score", type=int, default=45, help="Only include proactive follow-ups with score >= N.")
    obsidian.add_argument("--limit", type=int, default=20, help="Maximum follow-ups in the daily report.")
    obsidian.set_defaults(func=cmd_export_obsidian)

    obsidian_import = sub.add_parser(
        "import-obsidian",
        help="Import manual contact enrichment from Obsidian social-circle notes.",
    )
    obsidian_import.add_argument("--vault", type=Path, default=DEFAULT_OBSIDIAN_VAULT, help="Obsidian vault root.")
    obsidian_import.add_argument("--yes", action="store_true", help="Required to write imported enrichment.")
    obsidian_import.add_argument("--dry-run", action="store_true", help="Preview importable enrichment without writing.")
    obsidian_import.add_argument("--imported-at", help="Override import timestamp for tests/imports.")
    obsidian_import.set_defaults(func=cmd_import_obsidian)

    source_import = sub.add_parser(
        "import-source",
        help="Import local relationship sources such as contacts, calendars, meeting notes, Obsidian notes, or email files.",
    )
    source_import.add_argument("paths", type=Path, nargs="+", metavar="path")
    source_import.add_argument("--kind", choices=["auto", *SOURCE_TYPES], default="auto")
    source_import.add_argument("--yes", action="store_true", help="Required to write imported sources locally.")
    source_import.add_argument("--dry-run", action="store_true", help="Preview importable sources without writing.")
    source_import.add_argument("--imported-at", help="Override import timestamp for tests/imports.")
    source_import.set_defaults(func=cmd_import_source)

    sources = sub.add_parser("sources", help="List locally imported multi-source relationship records.")
    sources.add_argument("--contact", help="Only list sources for one contact.")
    sources.add_argument("--type", dest="source_type", choices=SOURCE_TYPES, help="Only list one source type.")
    sources.add_argument("--limit", type=int, default=50)
    sources.add_argument("--out", type=Path)
    sources.set_defaults(func=cmd_sources)

    weekly = sub.add_parser("weekly-report", help="Render a weekly relationship report.")
    weekly.add_argument("--date", help="Any date inside the ISO week. Defaults to today.")
    weekly.add_argument("--as-of", help="Analysis timestamp for recency scoring. Defaults to now.")
    weekly.add_argument("--min-score", type=int, default=45, help="Only include proactive follow-ups with score >= N.")
    weekly.add_argument("--limit", type=int, default=20, help="Maximum follow-ups in the weekly report.")
    weekly.add_argument("--out", type=Path)
    weekly.add_argument("--log-file", type=Path, help="Watch debug log path. Defaults to DB directory/watch.log.")
    weekly.add_argument("--captures-dir", type=Path, help="Screenshot directory. Defaults to DB directory/captures.")
    weekly.set_defaults(func=cmd_weekly_report)

    watch = sub.add_parser("watch", help="Explicitly watch the frontmost WeChat window and ingest changed OCR text.")
    watch.add_argument("--contact", help="Contact name hint; omit to guess from OCR.")
    watch.add_argument("--interval", type=int, help="Polling interval in seconds. Defaults to saved watch-interval setting.")
    watch.add_argument("--mode", choices=["screen", "window"], default="window")
    watch.add_argument("--app", action="append", default=None)
    watch.add_argument("--source", default="watch")
    watch.add_argument("--crop", help="Crop captured image before OCR as x,y,width,height.")
    watch.add_argument("--crop-preset", choices=["none", "wechat-chat"], default="none")
    watch.add_argument("--quiet-skip-every", type=int, default=30, help="Log repeated skip states every N polls.")
    watch.add_argument("--log-file", type=Path, help="Debug log path. Defaults to DB directory/watch.log.")
    watch.set_defaults(func=cmd_watch)
    return parser


def cmd_init(args: argparse.Namespace) -> int:
    init_db(args.db)
    print(f"initialized {args.db} schema={schema_version(args.db)}")
    return 0


def cmd_backup(args: argparse.Namespace) -> int:
    if not args.yes:
        raise SystemExit("Use --yes to write a consistent SQLite backup.")
    target = args.out or _default_backup_path(args.db)
    try:
        version = schema_version(args.db)
        backup_database(args.db, target)
    except (FileExistsError, FileNotFoundError, OSError, sqlite3.DatabaseError, ValueError) as exc:
        print(f"backup error: {exc}", file=sys.stderr)
        return 2
    print(f"backup={target} schema={version}")
    return 0


def cmd_connectors(args: argparse.Namespace) -> int:
    for status in connector_statuses():
        flags = []
        if status.can_capture:
            flags.append("capture")
        if status.can_read_text:
            flags.append("read_text")
        capability = ",".join(flags) or "none"
        print(f"{status.name}: {'available' if status.available else 'unavailable'} capabilities={capability} detail={status.detail}")
    return 0


def cmd_ingest(args: argparse.Namespace) -> int:
    raw_text = _read_text(args)
    result = ingest_capture(
        args.db,
        raw_text=raw_text,
        contact_hint=args.contact,
        source=args.source,
        captured_at=now_iso(),
        image_path=args.image_path,
        image_managed=False,
    )
    status = "inserted" if result.inserted else "duplicate"
    signals = _format_signal_kinds(result.signal_kinds)
    print(
        f"{status} capture={result.capture_id} contact={result.contact_name} "
        f"person={result.person_id} signals={signals}"
    )
    return 0


def cmd_capture(args: argparse.Namespace) -> int:
    outcome = _capture_once(args)
    print(outcome.output_line)
    return 0


def cmd_quick_capture(args: argparse.Namespace) -> int:
    return cmd_capture(args)


def _capture_once(args: argparse.Namespace) -> CaptureOutcome:
    root = Path(args.db).parent
    image_path = next_capture_path(root)
    try:
        capture_screenshot(
            image_path,
            mode=args.mode,
            crop=getattr(args, "crop", None),
            crop_preset=getattr(args, "crop_preset", "none"),
        )
        ocr_result = ocr_image(image_path)
        text = str(ocr_result)
        observations = getattr(ocr_result, "observations", None)
        result = ingest_capture(
            args.db,
            raw_text=text,
            contact_hint=args.contact,
            source=args.source,
            captured_at=now_iso(),
            image_path=str(image_path),
            image_managed=True,
            interaction_at=None,
            observations=observations,
        )
    except (CaptureError, EmptyCaptureError):
        if getattr(args, "command", None) == "watch":
            _remove_duplicate_image(image_path)
        raise
    status = "inserted" if result.inserted else "duplicate"
    signals = _format_signal_kinds(result.signal_kinds)
    image_field = f"image={image_path}"
    if result.image_attached:
        image_field = f"image_attached={image_path}"
    elif not result.inserted and _remove_duplicate_image(image_path):
        image_field = f"duplicate_image_removed={image_path}"
    output_line = (
        f"{status} capture={result.capture_id} contact={result.contact_name} "
        f"person={result.person_id} signals={signals} {image_field}"
    )
    return CaptureOutcome(output_line=output_line, log_detail=output_line)


def cmd_ocr_image(args: argparse.Namespace) -> int:
    print(ocr_image(args.image))
    return 0


def cmd_ocr_review(args: argparse.Namespace) -> int:
    if args.observation_id is None:
        reviews = list_ocr_reviews(
            args.db,
            status=args.status,
            max_confidence=args.max_confidence,
            limit=args.limit,
        )
        print(
            render_ocr_reviews(
                reviews,
                status=args.status,
                max_confidence=args.max_confidence,
            ),
            end="",
        )
        return 0
    if not args.action:
        print("ocr-review error: --action is required with --observation-id", file=sys.stderr)
        return 2
    if not args.yes:
        print("ocr-review error: use --yes after reviewing the observation", file=sys.stderr)
        return 2
    try:
        result = record_ocr_review(
            args.db,
            observation_id=args.observation_id,
            action=args.action,
            corrected_text=args.corrected_text,
            corrected_speaker=args.corrected_speaker,
            note=args.note,
            confirmed=True,
            confirmation_text=REVIEW_CONFIRMATION_TEXT,
            reviewed_at=args.reviewed_at,
        )
    except OCRReviewError as exc:
        print(f"ocr-review error: {exc}", file=sys.stderr)
        return 2
    review = result.review
    print(
        f"reviewed observation={review.observation_id} capture={review.capture_id} "
        f"action={result.action} capture_text_changed={result.capture_text_changed}"
    )
    return 0


def cmd_import_image(args: argparse.Namespace) -> int:
    missing_paths = [path for path in args.images if not path.exists()]
    if missing_paths:
        targets = ", ".join(str(path) for path in missing_paths)
        print(f"找不到图片或目录：{targets}")
        return 0
    unsupported_files = [
        path
        for path in args.images
        if path.is_file() and path.suffix.lower() not in IMAGE_SUFFIXES
    ]
    if unsupported_files:
        targets = ", ".join(str(path) for path in unsupported_files)
        print(
            f"不支持的图片类型：{targets}。"
            "支持的图片类型：png/jpg/jpeg/heic/tif/tiff。"
        )
        return 0
    images = _expand_import_images(args.images)
    if not images:
        targets = ", ".join(str(path) for path in args.images)
        print(
            f"没有找到可导入的图片：{targets}。"
            "支持的图片类型：png/jpg/jpeg/heic/tif/tiff。"
        )
        return 0
    inserted_count = 0
    duplicate_count = 0
    image_attached_count = 0
    for image in images:
        ocr_result = ocr_image(image)
        text = str(ocr_result)
        observations = getattr(ocr_result, "observations", None)
        result = ingest_capture(
            args.db,
            raw_text=text,
            contact_hint=args.contact,
            source=args.source,
            captured_at=now_iso(),
            image_path=str(image),
            image_managed=False,
            interaction_at=None,
            observations=observations,
        )
        status = "inserted" if result.inserted else "duplicate"
        if result.inserted:
            inserted_count += 1
        else:
            duplicate_count += 1
        if result.image_attached:
            image_attached_count += 1
        signals = _format_signal_kinds(result.signal_kinds)
        image_field = f"image={image}" if result.inserted else f"duplicate_image_ignored={image}"
        if result.image_attached:
            image_field = f"image_attached={image}"
        print(
            f"{status} capture={result.capture_id} contact={result.contact_name} "
            f"person={result.person_id} signals={signals} {image_field}"
        )
    if len(images) > 1:
        print(
            f"summary images={len(images)} inserted={inserted_count} "
            f"duplicate={duplicate_count} image_attached={image_attached_count}"
        )
    return 0


def _expand_import_images(paths: list[Path]) -> list[Path]:
    images: list[Path] = []
    for path in paths:
        if path.is_dir():
            images.extend(
                sorted(
                    (
                        child
                        for child in path.iterdir()
                        if child.is_file() and child.suffix.lower() in IMAGE_SUFFIXES
                    ),
                    key=_natural_path_name_key,
                )
            )
            continue
        images.append(path)
    return images


def _natural_path_name_key(path: Path):
    return tuple(
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", path.name)
    )


def cmd_suggest(args: argparse.Namespace) -> int:
    init_db(args.db)
    search_limit = 1000 if args.contact else args.limit
    matched_profiles = _matching_profiles(args.db, args.contact)
    suggestions = build_suggestions(args.db, as_of=args.as_of, limit=search_limit, min_score=args.min_score)
    suggestions = _filter_suggestions(
        suggestions,
        args.contact,
        matched_profiles=matched_profiles,
    )[: args.limit]
    hidden_suggestion = _best_hidden_suggestion(
        args.db,
        args.contact,
        min_score=args.min_score,
        as_of=args.as_of,
        matched_profiles=matched_profiles,
    ) if not suggestions else None
    markdown = render_markdown(
        suggestions,
        title=args.title,
        empty_message=_suggestions_empty_message(
            args.contact,
            min_score=args.min_score,
            hidden_suggestion=hidden_suggestion,
        ),
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_next(args: argparse.Namespace) -> int:
    init_db(args.db)
    limit = 1000 if args.contact else 1
    matched_profiles = _matching_profiles(args.db, args.contact)
    suggestions = build_suggestions(args.db, as_of=args.as_of, limit=limit, min_score=args.min_score)
    suggestions = _filter_suggestions(
        suggestions,
        args.contact,
        matched_profiles=matched_profiles,
    )
    if not suggestions:
        hidden_suggestion = _best_hidden_suggestion(
            args.db,
            args.contact,
            min_score=args.min_score,
            as_of=args.as_of,
            matched_profiles=matched_profiles,
        )
        print(
            _suggestions_empty_message(
                args.contact,
                min_score=args.min_score,
                hidden_suggestion=hidden_suggestion,
            )
        )
        return 0
    top = suggestions[0]
    if args.draft_only:
        print(top.draft)
        return 0
    print("# 下一条跟进")
    print(f"人：{top.person_name}")
    print(f"动作：{top.action}")
    print(f"分数：{top.score}")
    print(f"跟进强度：{followup_strength_label(top.score)}")
    print(f"最近互动：{format_display_time(top.last_interaction_at)}")
    evidence = _evidence_for_suggestion(args.db, top)
    if evidence:
        print(f"证据会话：{evidence.chat_name}")
        print(f"证据时间：{format_display_time(evidence.captured_at)}")
        if evidence.image_path:
            print(f"证据截图：{evidence.image_path}")
    print(f"原因：{top.why}")
    print(f"草稿：{top.draft}")
    return 0


def cmd_contacts(args: argparse.Namespace) -> int:
    init_db(args.db)
    query = args.contact or args.query
    profiles = build_profiles(args.db)
    profiles = _filter_profiles(profiles, query)
    if args.limit is not None:
        profiles = profiles[: args.limit]
    markdown = _render_contacts_markdown(profiles, query=query)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_brief(args: argparse.Namespace) -> int:
    init_db(args.db)
    query = args.contact or args.query
    if not query:
        print("brief requires a query or --contact.", file=sys.stderr)
        return 2
    profiles = _filter_profiles(build_profiles(args.db), query)
    suggestions = build_suggestions(args.db, as_of=args.as_of, limit=1000, min_score=args.min_score)
    suggestions = _filter_suggestions(suggestions, query, matched_profiles=profiles)
    hidden_suggestion = _best_hidden_suggestion(
        args.db,
        query,
        min_score=args.min_score,
        as_of=args.as_of,
        matched_profiles=profiles,
    ) if not suggestions else None
    markdown = _render_brief_markdown(
        profiles,
        suggestions[:1],
        query=query,
        evidence=_brief_display_evidence(args.db, profiles, suggestions[:1]),
        no_suggestion_message=_brief_no_suggestion_message(
            query,
            min_score=args.min_score,
            hidden_suggestion=hidden_suggestion,
        ),
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_profiles(args: argparse.Namespace) -> int:
    init_db(args.db)
    profiles = build_profiles(args.db, limit=_pre_filter_profile_limit(args.contact, args.limit))
    profiles = _filter_profiles(profiles, args.contact)
    profiles = _post_filter_limit(profiles, args.contact, args.limit)
    markdown = render_profiles_markdown(
        profiles,
        title=args.title,
        empty_message=_profiles_empty_message(args.contact),
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_quality(args: argparse.Namespace) -> int:
    init_db(args.db)
    profiles = build_profiles(args.db)
    profiles = _filter_profiles(profiles, args.contact)
    cards = build_relationship_quality_cards(
        args.db,
        profiles=profiles,
        as_of=args.as_of,
        limit=args.limit,
        min_suggestion_score=args.min_score,
    )
    markdown = render_relationship_quality_markdown(cards)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_dashboard(args: argparse.Namespace) -> int:
    dashboard = build_relationship_dashboard(
        args.db,
        as_of=args.as_of,
        limit=args.limit,
        min_score=args.min_score,
    )
    markdown = render_relationship_dashboard_markdown(dashboard)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_import_wechat_archive(args: argparse.Namespace) -> int:
    if not args.yes and not args.dry_run:
        raise SystemExit("Use --yes to import WeChat archive sources, or --dry-run to preview.")
    init_db(args.db)
    removed = delete_wechat_archive_sources(args.db) if args.yes and args.replace and not args.dry_run else 0
    known_contacts = _known_contact_names(args.db, extra=args.contact_hint)
    result = import_wechat_archive_manifest(
        args.db,
        manifest_path=args.manifest,
        known_contacts=known_contacts,
        dry_run=args.dry_run,
        imported_at=args.imported_at,
        limit=args.limit,
        min_score=args.min_score,
        include_unmatched=args.include_unmatched and not args.only_matched,
        include_sensitive=args.include_sensitive,
    )
    markdown = render_wechat_archive_import_markdown(result)
    if removed:
        markdown = markdown.rstrip() + f"\n\n已替换旧微信归档来源：{removed}\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_cockpit(args: argparse.Namespace) -> int:
    if not args.yes and not args.dry_run:
        raise SystemExit("Use --yes to import sources before rendering, or --dry-run to preview.")
    init_db(args.db)
    write_imports = args.yes and not args.dry_run
    removed_archive_sources = (
        delete_wechat_archive_sources(args.db)
        if write_imports and args.replace_wechat_archive
        else 0
    )

    obsidian_enrichment_result = import_obsidian_enrichments(
        args.db,
        vault=args.vault,
        dry_run=not write_imports,
        imported_at=args.imported_at,
    )
    obsidian_source_result = import_relationship_sources(
        args.db,
        paths=[args.vault],
        kind="obsidian",
        dry_run=not write_imports,
        imported_at=args.imported_at,
    )
    known_contacts = _known_contact_names(
        args.db,
        extra=_vault_contact_names(args.vault),
    )
    archive_result = import_wechat_archive_manifest(
        args.db,
        manifest_path=args.wechat_manifest,
        known_contacts=known_contacts,
        dry_run=not write_imports,
        imported_at=args.imported_at,
        limit=args.archive_limit,
        min_score=args.archive_min_score,
        include_unmatched=True,
        include_sensitive=args.include_sensitive,
    )

    if write_imports:
        refresh_capture_signals(args.db)
        refresh_derived_people(args.db)

    dashboard = build_relationship_dashboard(
        args.db,
        as_of=args.as_of,
        limit=args.limit,
        min_score=args.min_score,
    )
    markdown = _render_cockpit_markdown(
        dashboard,
        obsidian_enrichment_result=obsidian_enrichment_result,
        obsidian_source_result=obsidian_source_result,
        archive_result=archive_result,
        write_imports=write_imports,
        removed_archive_sources=removed_archive_sources,
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_candidates(args: argparse.Namespace) -> int:
    init_db(args.db)
    if args.sync:
        candidates = sync_relationship_candidates(
            args.db,
            min_confidence=args.min_confidence,
            limit=args.limit,
        )
    else:
        candidates = discover_relationship_candidates(
            args.db,
            min_confidence=args.min_confidence,
            limit=args.limit,
        )
    if args.status:
        candidates = [candidate for candidate in candidates if candidate.status == args.status]
    markdown = render_candidates_markdown(candidates)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_candidate_confirm(args: argparse.Namespace) -> int:
    if not args.yes:
        raise SystemExit("Use --yes to confirm a relationship candidate locally.")
    if args.candidate_id is None and (not args.name or not args.source_chat):
        raise SystemExit("Provide --id or both NAME and --source-chat.")
    result = confirm_relationship_candidate(
        args.db,
        candidate_id=args.candidate_id,
        name=args.name,
        source_chat=args.source_chat,
        confirmed_at=args.confirmed_at,
        note=args.note,
    )
    print(
        f"confirmed candidate id={result.id} name={result.name} "
        f"source_chat={result.source_chat} status={result.status}"
    )
    return 0


def cmd_feedback(args: argparse.Namespace) -> int:
    try:
        result = record_feedback(
            args.db,
            person_name=args.contact,
            action=args.action,
            note=args.note,
            until_at=args.until_at,
            created_at=args.created_at,
        )
    except ValueError as exc:
        print(f"feedback error: {exc}", file=sys.stderr)
        return 2
    until = f" until={format_display_time(result.until_at)}" if result.until_at else ""
    print(f"recorded feedback id={result.id} contact={result.person_name} action={result.action}{until}")
    return 0


def cmd_feedback_list(args: argparse.Namespace) -> int:
    records = list_feedback(args.db, person_name=args.contact, limit=args.limit)
    markdown = render_feedback_markdown(records)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    report = build_status_report(args.db, log_file=args.log_file, captures_dir=args.captures_dir, as_of=args.as_of)
    print(render_status_report(report), end="")
    return 0


def cmd_audit(args: argparse.Namespace) -> int:
    report = build_audit_report(args.db)
    markdown = render_audit_report_markdown(report)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_export_data(args: argparse.Namespace) -> int:
    if not args.yes:
        raise SystemExit("Use --yes to export local data to a file.")
    result = export_local_data(args.db, out_path=args.out)
    tables = _audit_table_summary(result.table_counts)
    print(f"exported local data: out={result.out_path} {tables}")
    return 0


def cmd_delete_contact(args: argparse.Namespace) -> int:
    if not args.yes and not args.dry_run:
        raise SystemExit("Use --yes to delete a contact, or --dry-run to preview.")
    result = delete_contact_data(args.db, args.contact, dry_run=args.dry_run)
    prefix = "dry-run" if result.dry_run else "deleted contact"
    print(
        f"{prefix}: contact={result.person_name} "
        f"people={result.removed_people} captures={result.removed_captures} "
        f"signals={result.removed_signals} observations={result.removed_observations} "
        f"reviews={result.removed_reviews} review_events={result.removed_review_events} feedback={result.removed_feedback} "
        f"candidates={result.removed_candidates} enrichments={result.removed_enrichments} "
        f"sources={result.removed_sources} screenshots={result.removed_screenshots}"
    )
    return 0


def cmd_stop_watch(args: argparse.Namespace) -> int:
    pids = stop_watch_processes(dry_run=args.dry_run, db_path=args.db)
    if not pids:
        print("没有发现正在运行的自动截图进程。")
        return 0
    pid_list = ", ".join(str(pid) for pid in pids)
    if args.dry_run:
        print(f"将停止自动截图进程：{pid_list}")
    else:
        print(f"已停止自动截图进程：{pid_list}")
    return 0


def cmd_watch_interval(args: argparse.Namespace) -> int:
    if args.seconds is None:
        settings = load_settings(args.db)
    else:
        try:
            settings = save_watch_interval(args.db, args.seconds)
        except ValueError as exc:
            print(f"watch-interval error: {exc}", file=sys.stderr)
            return 2
    print(
        f"watch_interval_seconds={settings.watch_interval_seconds} "
        f"settings={_display_settings_path(args.db)}"
    )
    return 0


def cmd_reset(args: argparse.Namespace) -> int:
    if not args.yes and not args.dry_run:
        raise SystemExit("Use --yes to clear database rows and screenshots, or --dry-run to preview.")
    result = reset_memory(args.db, captures_dir=args.captures_dir, dry_run=args.dry_run)
    prefix = "dry-run" if result.dry_run else "reset complete"
    print(
        f"{prefix}: people={result.removed_people} "
        f"captures={result.removed_captures} "
        f"signals={result.removed_signals} "
        f"feedback={result.removed_feedback} "
        f"candidates={result.removed_candidates} "
        f"enrichments={result.removed_enrichments} "
        f"sources={result.removed_sources} "
        f"screenshots={result.removed_screenshots}"
    )
    return 0


def cmd_analyze(args: argparse.Namespace) -> int:
    init_db(args.db)
    refresh_capture_signals(args.db)
    refresh_derived_people(args.db)
    report = build_status_report(args.db, log_file=args.log_file, captures_dir=args.captures_dir, as_of=args.as_of)
    profiles = build_profiles(args.db, limit=_pre_filter_profile_limit(args.contact, args.limit))
    matched_profiles = _filter_profiles(profiles, args.contact)
    matched_profile_count = len(matched_profiles)
    matched_latest = _format_matching_latest(matched_profiles)
    profiles = _post_filter_limit(matched_profiles, args.contact, args.limit)
    search_limit = 1000 if args.contact else args.limit
    suggestions = build_suggestions(args.db, as_of=args.as_of, limit=search_limit, min_score=args.min_score)
    suggestions = _filter_suggestions(suggestions, args.contact, matched_profiles=matched_profiles)[: args.limit]
    hidden_suggestion = _best_hidden_suggestion(
        args.db,
        args.contact,
        min_score=args.min_score,
        as_of=args.as_of,
        matched_profiles=matched_profiles,
    ) if not suggestions else None

    profiles_markdown = render_profiles_markdown(
        profiles,
        title="联系人关系档案",
        empty_message=_profiles_empty_message(args.contact),
    )
    suggestions_markdown = render_markdown(
        suggestions,
        title="社交跟进建议",
        empty_message=_suggestions_empty_message(
            args.contact,
            min_score=args.min_score,
            hidden_suggestion=hidden_suggestion,
        ),
    )
    _write_text(args.profiles_out, profiles_markdown)
    _write_text(args.suggestions_out, suggestions_markdown)

    latest = (
        f"{format_display_time(report.latest_captured_at)} {report.latest_contact}"
        if report.latest_captured_at and report.latest_contact
        else "无"
    )
    print("# 微信社交助手分析")
    if args.contact:
        print(f"过滤：{args.contact}")
    print(f"联系人：{report.contact_count}")
    if args.contact:
        print(f"匹配联系人：{matched_profile_count}")
        print(f"匹配最近出现：{matched_latest}")
    print(f"档案：{len(profiles)}")
    print(f"采集：{report.capture_count}")
    print(f"截图：{report.screenshot_count}")
    print(f"自动截图：{'运行中' if report.watch_running else '未运行'}")
    quality_notes = status_quality_notes(report)
    print(f"质量提示：{'；'.join(quality_notes) if quality_notes else '未发现明显采集风险'}")
    print(f"建议阈值：{args.min_score}")
    print(f"跟进建议数：{len(suggestions)}")
    threshold_note = _threshold_filtered_message(
        args.contact,
        args.min_score,
        hidden_suggestion,
    )
    if threshold_note:
        print(f"阈值提示：{threshold_note}")
    print(f"首要跟进：{_format_top_suggestion(suggestions)}")
    print(f"首条草稿：{_format_top_draft(suggestions)}")
    print(f"最近采集：{latest}")
    print(f"联系人报告：{args.profiles_out}")
    print(f"跟进建议：{args.suggestions_out}")
    if report.last_log_line:
        print(f"最近日志：{report.last_log_line}")
    return 0


def cmd_export_obsidian(args: argparse.Namespace) -> int:
    init_db(args.db)
    refresh_capture_signals(args.db)
    refresh_derived_people(args.db)
    report_date = _obsidian_report_date(args.date)
    vault = Path(args.vault)
    people_dir = vault / "社交圈" / "人脉"
    reports_dir = vault / "社交圈" / "分析报告"
    people_dir.mkdir(parents=True, exist_ok=True)
    reports_dir.mkdir(parents=True, exist_ok=True)

    profiles = build_profiles(args.db)
    filename_by_name = _obsidian_filename_map(profile.name for profile in profiles)
    enrichments = enrichment_by_person(args.db)
    all_suggestions = build_suggestions(args.db, as_of=args.as_of, limit=1000, min_score=0)
    suggestions_by_person = _suggestions_by_person(all_suggestions)
    written_contacts = []
    for profile in profiles:
        suggestion = suggestions_by_person.get(profile.name)
        evidence = _evidence_for_suggestion(args.db, suggestion) if suggestion else _brief_evidence(args.db, profile)
        path = people_dir / f"{filename_by_name[profile.name]}.md"
        _write_text(
            path,
            _render_obsidian_contact_markdown(
                profile,
                suggestion,
                evidence=evidence,
                filename_by_name=filename_by_name,
                enrichment=enrichments.get(profile.name),
            ),
        )
        written_contacts.append(path)
    followups = build_suggestions(args.db, as_of=args.as_of, limit=args.limit, min_score=args.min_score)
    people_index_path = people_dir / "索引.md"
    _write_text(
        people_index_path,
        _render_obsidian_people_index(
            profiles,
            followups,
            filename_by_name=filename_by_name,
            enrichments_by_person=enrichments,
        ),
    )
    status_report = build_status_report(
        args.db,
        log_file=Path(args.db).parent / "watch.log",
        captures_dir=Path(args.db).parent / "captures",
        as_of=args.as_of,
    )
    report_path = reports_dir / f"{report_date}.md"
    _write_text(
        report_path,
        _render_obsidian_daily_report(
            report_date,
            profiles,
            followups,
            status_report=status_report,
            min_score=args.min_score,
            filename_by_name=filename_by_name,
            enrichments_by_person=enrichments,
        ),
    )
    weekly_path = reports_dir / f"{_obsidian_week_label(report_date)}.md"
    _write_text(
        weekly_path,
        _render_obsidian_weekly_report(
            report_date,
            profiles,
            followups,
            status_report=status_report,
            min_score=args.min_score,
            filename_by_name=filename_by_name,
            enrichments_by_person=enrichments,
        ),
    )
    print(
        f"exported contacts={len(written_contacts)} "
        f"people_dir={people_dir} index={people_index_path} report={report_path} weekly={weekly_path}"
    )
    return 0


def cmd_import_obsidian(args: argparse.Namespace) -> int:
    if not args.yes and not args.dry_run:
        raise SystemExit("Use --yes to import Obsidian enrichment, or --dry-run to preview.")
    result = import_obsidian_enrichments(
        args.db,
        vault=args.vault,
        dry_run=args.dry_run,
        imported_at=args.imported_at,
    )
    prefix = "dry-run" if result.dry_run else "imported obsidian enrichments"
    print(
        f"{prefix}: scanned={result.scanned_count} "
        f"parsed={result.parsed_count} imported={result.imported_count}"
    )
    return 0


def cmd_import_source(args: argparse.Namespace) -> int:
    if not args.yes and not args.dry_run:
        raise SystemExit("Use --yes to import relationship sources, or --dry-run to preview.")
    result = import_relationship_sources(
        args.db,
        paths=args.paths,
        kind=args.kind,
        dry_run=args.dry_run,
        imported_at=args.imported_at,
    )
    prefix = "dry-run" if result.dry_run else "imported relationship sources"
    type_summary = _source_import_type_summary(result.by_type)
    suffix = f" {type_summary}" if type_summary else ""
    print(
        f"{prefix}: scanned={result.scanned_count} parsed={result.parsed_count} "
        f"imported={result.imported_count} duplicates={result.duplicate_count} "
        f"skipped={result.skipped_count}{suffix}"
    )
    return 0


def cmd_sources(args: argparse.Namespace) -> int:
    records = list_relationship_sources(
        args.db,
        person_name=args.contact,
        source_type=args.source_type,
        limit=args.limit,
    )
    markdown = render_relationship_sources_markdown(records)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def cmd_weekly_report(args: argparse.Namespace) -> int:
    init_db(args.db)
    refresh_capture_signals(args.db)
    refresh_derived_people(args.db)
    report_date = _obsidian_report_date(args.date)
    profiles = build_profiles(args.db)
    followups = build_suggestions(args.db, as_of=args.as_of, limit=args.limit, min_score=args.min_score)
    status_report = build_status_report(args.db, log_file=args.log_file, captures_dir=args.captures_dir, as_of=args.as_of)
    filename_by_name = _obsidian_filename_map(profile.name for profile in profiles)
    markdown = _render_obsidian_weekly_report(
        report_date,
        profiles,
        followups,
        status_report=status_report,
        min_score=args.min_score,
        filename_by_name=filename_by_name,
        enrichments_by_person=enrichment_by_person(args.db),
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown, end="")
    return 0


def _known_contact_names(args_db: Path, *, extra=()) -> list[str]:
    init_db(args_db)
    names = {profile.name for profile in build_profiles(args_db)}
    names.update(record.person_name for record in list_contact_enrichments(args_db, limit=10000))
    names.update(str(item).strip() for item in extra if str(item).strip())
    return sorted(names)


def _vault_contact_names(vault: Path) -> list[str]:
    people_dir = Path(vault) / "社交圈" / "人脉"
    if not people_dir.exists():
        return []
    return sorted(path.stem for path in people_dir.glob("*.md") if path.stem != "索引")


def _render_cockpit_markdown(
    dashboard,
    *,
    obsidian_enrichment_result,
    obsidian_source_result,
    archive_result,
    write_imports: bool,
    removed_archive_sources: int = 0,
) -> str:
    mode = "已导入并刷新" if write_imports else "预览模式，未写入新来源"
    lines = [
        "# 关系跟进驾驶舱",
        "",
        f"- 模式：{mode}",
        f"- 联系人补充扫描：{obsidian_enrichment_result.scanned_count}",
        f"- 联系人补充导入：{obsidian_enrichment_result.imported_count}",
        f"- 联系人来源解析：{obsidian_source_result.parsed_count}",
        f"- 联系人来源导入：{obsidian_source_result.imported_count}",
        f"- 微信归档文件清单扫描：{archive_result.scanned_count}",
        f"- 微信归档文件线索选中：{archive_result.parsed_count}",
        f"- 微信归档文件线索导入：{archive_result.imported_count}",
        f"- 微信归档文件线索重复：{archive_result.duplicate_count}",
        f"- 微信归档文件线索替换旧记录：{removed_archive_sources}",
        f"- 微信归档文件线索跳过高敏感：{archive_result.skipped_sensitive_count}",
        "",
        "## 微信归档文件线索分桶",
        "",
    ]
    if archive_result.by_bucket:
        for name, count in sorted(archive_result.by_bucket.items(), key=lambda item: (-item[1], item[0]))[:12]:
            lines.append(f"- {name}: {count}")
    else:
        lines.append("- 暂无。")
    lines.extend(["", "## 今日操作视图", ""])
    rendered_dashboard = render_relationship_dashboard_markdown(dashboard).strip()
    lines.append(rendered_dashboard)
    lines.extend(
        [
            "",
            "## 使用原则",
            "",
            "- 只给建议和草稿，不自动发送微信消息。",
            "- 微信归档部分目前只导入文件清单元数据，不代表已导入聊天记录。",
            "- 微信归档文件线索默认跳过高敏感文件名，例如合同、简历、发票、股权、薪酬等。",
            "- 联系人资料来自本地 Hbrain/社交圈，不写回原始微信归档。",
            "- 如果某条建议不合适，用 `wsa feedback` 标记，后续会降低类似提醒。",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"


def _suggestions_by_person(suggestions) -> dict[str, object]:
    result = {}
    for suggestion in suggestions:
        result.setdefault(suggestion.person_name, suggestion)
    return result


def _obsidian_report_date(value: str | None) -> str:
    if value is None:
        return datetime.now().astimezone().date().isoformat()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise SystemExit("--date must be YYYY-MM-DD")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise SystemExit("--date must be YYYY-MM-DD") from exc
    return value


def _obsidian_filename_map(names) -> dict[str, str]:
    result: dict[str, str] = {}
    used: set[str] = set()
    for name in sorted(dict.fromkeys(names)):
        base = _safe_markdown_filename(name)
        candidate = base
        suffix = 2
        while candidate.casefold() in used:
            candidate = f"{base}-{suffix}"
            suffix += 1
        used.add(candidate.casefold())
        result[name] = candidate
    return result


def _render_obsidian_contact_markdown(
    profile,
    suggestion=None,
    *,
    evidence: BriefEvidence | None = None,
    filename_by_name: dict[str, str] | None = None,
    enrichment: ContactEnrichment | None = None,
) -> str:
    lines = [
        f"# {profile.name}",
        "",
        f"- 类型：{_contact_kind_label(profile.kind)}",
        f"- 最近出现：{format_display_time(profile.last_seen_at)}",
    ]
    if profile.source_chats:
        lines.append(f"- 来源群/会话：{_obsidian_contact_links(profile.source_chats, filename_by_name=filename_by_name)}")
    if profile.speakers:
        lines.append(f"- 近期发言人：{_obsidian_contact_links(profile.speakers, filename_by_name=filename_by_name)}")
    if profile.identity_hints:
        lines.append(f"- 身份线索：{', '.join(profile.identity_hints)}")
    if profile.organizations:
        lines.append(f"- 机构/公司：{', '.join(profile.organizations)}")
    if profile.signals:
        lines.append(f"- 关系信号：{', '.join(signal_label(signal) for signal in profile.signals)}")
    if profile.links:
        lines.append(f"- 链接：{', '.join(profile.links)}")
    if profile.files:
        lines.append(f"- 文件：{', '.join(profile.files)}")

    lines.extend(_obsidian_manual_section(enrichment))

    profile_gaps = _profile_information_gaps(profile, enrichment=enrichment)
    if profile_gaps:
        lines.extend(["", "## 资料缺口"])
        lines.extend(f"- {gap}" for gap in profile_gaps)

    lines.extend(["", "## 最近联系内容"])
    if profile.recent_contents:
        lines.extend(f"- {item}" for item in profile.recent_contents[:8])
    else:
        lines.append("- 暂无最近联系内容。")

    if evidence:
        lines.extend(
            [
                "",
                "## 最近采集证据",
                f"- 会话：{evidence.chat_name}",
                f"- 采集时间：{format_display_time(evidence.captured_at)}",
                f"- 来源：{evidence.source}",
            ]
        )
        if evidence.image_path:
            lines.append(f"- 截图：{evidence.image_path}")

    lines.extend(["", "## 下一步"])
    if suggestion:
        lines.extend(
            [
                f"- 动作：{suggestion.action}",
                f"- 分数：{suggestion.score}",
                f"- 跟进强度：{followup_strength_label(suggestion.score)}",
                f"- 原因：{suggestion.why}",
                "",
                f"草稿：{suggestion.draft}",
            ]
        )
    else:
        lines.append("暂无匹配跟进建议。")
    return "\n".join(lines).rstrip() + "\n"


def _render_obsidian_people_index(
    profiles,
    followups=(),
    *,
    filename_by_name: dict[str, str] | None = None,
    enrichments_by_person: dict[str, ContactEnrichment] | None = None,
) -> str:
    enrichments_by_person = enrichments_by_person or {}
    lines = [
        "# 人脉索引",
        "",
        f"- 联系人档案：{len(profiles)}",
        "",
        "## 优先跟进",
    ]
    if followups:
        for index, suggestion in enumerate(followups, start=1):
            lines.extend(_obsidian_index_followup_lines(index, suggestion, filename_by_name=filename_by_name))
    else:
        lines.append("- 暂无达到当前阈值的优先跟进。")
    lines.extend(
        [
            "",
            "## 最近联系人",
        ]
    )
    if profiles:
        lines.extend(
            _obsidian_people_index_line(
                profile,
                filename_by_name=filename_by_name,
                enrichment=enrichments_by_person.get(profile.name),
            )
            for profile in profiles
        )
    else:
        lines.append("- 暂无联系人档案。")
    return "\n".join(lines).rstrip() + "\n"


def _obsidian_index_followup_lines(
    index: int,
    suggestion,
    *,
    filename_by_name: dict[str, str] | None = None,
) -> list[str]:
    return [
        (
            f"{index}. {_obsidian_contact_link(suggestion.person_name, filename_by_name=filename_by_name)} / {suggestion.action} / "
            f"{suggestion.score}分 / {followup_strength_label(suggestion.score)}"
        ),
        f"   - 最近互动：{format_display_time(suggestion.last_interaction_at)}",
        f"   - 草稿：{suggestion.draft}",
    ]


def _obsidian_people_index_line(
    profile,
    *,
    filename_by_name: dict[str, str] | None = None,
    enrichment: ContactEnrichment | None = None,
) -> str:
    summary = _obsidian_people_index_summary(
        profile,
        filename_by_name=filename_by_name,
        enrichment=enrichment,
    )
    return (
        f"- {_obsidian_contact_link(profile.name, filename_by_name=filename_by_name)}"
        f"（{_contact_kind_label(profile.kind)}，{format_display_time(profile.last_seen_at)}）：{summary}"
    )


def _obsidian_people_index_summary(
    profile,
    *,
    filename_by_name: dict[str, str] | None = None,
    enrichment: ContactEnrichment | None = None,
) -> str:
    details = []
    if profile.source_chats:
        details.append(f"来源：{_obsidian_contact_links(profile.source_chats, filename_by_name=filename_by_name)}")
    if profile.speakers:
        details.append(f"近期发言人：{_obsidian_contact_links(profile.speakers, filename_by_name=filename_by_name)}")
    if profile.organizations:
        details.append(f"机构/公司：{', '.join(profile.organizations)}")
    if profile.identity_hints:
        details.append(f"身份线索：{', '.join(profile.identity_hints)}")
    if profile.signals:
        details.append(f"关系信号：{', '.join(signal_label(signal) for signal in profile.signals)}")
    if enrichment:
        details.append(f"手工补充：{enrichment_summary(enrichment)}")
    gaps = _profile_information_gaps(profile, enrichment=enrichment)
    if gaps:
        details.append(f"资料缺口：{'；'.join(gaps)}")
    return "；".join(details) if details else "暂无摘要"


def _render_obsidian_daily_report(
    report_date: str,
    profiles,
    followups,
    *,
    status_report,
    min_score: int,
    filename_by_name: dict[str, str] | None = None,
    enrichments_by_person: dict[str, ContactEnrichment] | None = None,
) -> str:
    enrichments_by_person = enrichments_by_person or {}
    kind_counts = {
        "私聊/单聊": sum(1 for profile in profiles if profile.kind == "direct"),
        "群聊": sum(1 for profile in profiles if profile.kind == "group"),
        "群内联系人": sum(1 for profile in profiles if profile.kind == "speaker"),
        "多入口来源": sum(1 for profile in profiles if profile.kind == "source"),
    }
    signaled_profiles = [profile for profile in profiles if profile.signals]
    lines = [
        f"# 社交圈分析报告 {report_date}",
        "",
        "## 人脉分析",
        f"- 联系人档案：{len(profiles)}",
        f"- 数据库联系人：{status_report.contact_count}",
        f"- 采集记录：{status_report.capture_count}",
        f"- 截图：{status_report.screenshot_count}",
        f"- 自动截图：{'运行中' if status_report.watch_running else '未运行'}",
        f"- 私聊/单聊：{kind_counts['私聊/单聊']}",
        f"- 群聊：{kind_counts['群聊']}",
        f"- 群内联系人：{kind_counts['群内联系人']}",
        f"- 多入口来源：{kind_counts['多入口来源']}",
        f"- 有关系信号的人脉：{len(signaled_profiles)}",
    ]
    quality_notes = status_quality_notes(status_report)
    if quality_notes:
        lines.append(f"- 质量提示：{'；'.join(quality_notes)}")
    if signaled_profiles:
        lines.extend(["", "### 有关系信号的人脉"])
        for profile in signaled_profiles:
            signals = ", ".join(signal_label(signal) for signal in profile.signals)
            lines.append(f"- {_obsidian_contact_link(profile.name, filename_by_name=filename_by_name)}：{signals}")

    enriched_profiles = [profile for profile in profiles if profile.name in enrichments_by_person]
    if enriched_profiles:
        lines.extend(["", "### 手工补充的人脉"])
        for profile in enriched_profiles[:12]:
            enrichment = enrichments_by_person[profile.name]
            lines.append(
                f"- {profile.name}：{enrichment_summary(enrichment)}"
                f"（{_obsidian_contact_link(profile.name, filename_by_name=filename_by_name)}）"
            )

    recent_profiles = sorted(profiles, key=lambda profile: (profile.last_seen_at, profile.name), reverse=True)[:8]
    if recent_profiles:
        lines.extend(["", "### 最近出现的人脉"])
        lines.extend(_obsidian_recent_profile_line(profile, filename_by_name=filename_by_name) for profile in recent_profiles)

    gap_profiles = [
        profile
        for profile in recent_profiles
        if _profile_information_gaps(profile, enrichment=enrichments_by_person.get(profile.name))
    ]
    if gap_profiles:
        lines.extend(["", "### 需要补充信息的人脉"])
        lines.extend(
            _obsidian_profile_gap_line(
                profile,
                filename_by_name=filename_by_name,
                enrichment=enrichments_by_person.get(profile.name),
            )
            for profile in gap_profiles
        )

    lines.extend(["", "## 应该主动联系的人"])
    if followups:
        for index, suggestion in enumerate(followups, start=1):
            lines.extend(
                [
                    f"{index}. {_obsidian_contact_link(suggestion.person_name, filename_by_name=filename_by_name)} / {suggestion.action} / {suggestion.score}分 / {followup_strength_label(suggestion.score)}",
                    f"   - 最近互动：{format_display_time(suggestion.last_interaction_at)}",
                    f"   - 原因：{suggestion.why}",
                    f"   - 草稿：{suggestion.draft}",
                ]
            )
    else:
        lines.append(f"- 暂无达到阈值 {min_score} 的主动联系建议。")
    return "\n".join(lines).rstrip() + "\n"


def _render_obsidian_weekly_report(
    report_date: str,
    profiles,
    followups,
    *,
    status_report,
    min_score: int,
    filename_by_name: dict[str, str] | None = None,
    enrichments_by_person: dict[str, ContactEnrichment] | None = None,
) -> str:
    enrichments_by_person = enrichments_by_person or {}
    week_label = _obsidian_week_label(report_date)
    week_start, week_end = _obsidian_week_range(report_date)
    kind_counts = {
        "私聊/单聊": sum(1 for profile in profiles if profile.kind == "direct"),
        "群聊": sum(1 for profile in profiles if profile.kind == "group"),
        "群内联系人": sum(1 for profile in profiles if profile.kind == "speaker"),
        "手工补充": sum(1 for profile in profiles if profile.kind == "manual"),
        "多入口来源": sum(1 for profile in profiles if profile.kind == "source"),
    }
    gap_profiles = [
        profile
        for profile in profiles
        if _profile_information_gaps(profile, enrichment=enrichments_by_person.get(profile.name))
    ][:12]
    enriched_profiles = [profile for profile in profiles if profile.name in enrichments_by_person][:12]
    recent_profiles = sorted(profiles, key=lambda profile: (profile.last_seen_at, profile.name), reverse=True)[:12]
    lines = [
        f"# 社交圈周报 {week_label}",
        "",
        f"- 周期：{week_start.isoformat()} 至 {week_end.isoformat()}",
        f"- 联系人档案：{len(profiles)}",
        f"- 数据库联系人：{status_report.contact_count}",
        f"- 采集记录：{status_report.capture_count}",
        f"- 私聊/单聊：{kind_counts['私聊/单聊']}",
        f"- 群聊：{kind_counts['群聊']}",
        f"- 群内联系人：{kind_counts['群内联系人']}",
        f"- 多入口来源：{kind_counts['多入口来源']}",
        f"- 手工补充：{len(enrichments_by_person)}",
        "",
        "## 本周应主动联系",
    ]
    if followups:
        for index, suggestion in enumerate(followups, start=1):
            lines.extend(
                [
                    f"{index}. {_obsidian_contact_link(suggestion.person_name, filename_by_name=filename_by_name)} / {suggestion.action} / {suggestion.score}分 / {followup_strength_label(suggestion.score)}",
                    f"   - 原因：{suggestion.why}",
                    f"   - 草稿：{suggestion.draft}",
                ]
            )
    else:
        lines.append(f"- 暂无达到阈值 {min_score} 的主动联系建议。")

    lines.extend(["", "## 本周手工补充"])
    if enriched_profiles:
        for profile in enriched_profiles:
            enrichment = enrichments_by_person[profile.name]
            lines.append(
                f"- {profile.name}：{enrichment_summary(enrichment)}"
                f"（{_obsidian_contact_link(profile.name, filename_by_name=filename_by_name)}）"
            )
    else:
        lines.append("- 暂无手工补充。")

    lines.extend(["", "## 资料缺口"])
    if gap_profiles:
        lines.extend(
            _obsidian_profile_gap_line(
                profile,
                filename_by_name=filename_by_name,
                enrichment=enrichments_by_person.get(profile.name),
            )
            for profile in gap_profiles
        )
    else:
        lines.append("- 暂无明显资料缺口。")

    lines.extend(["", "## 最近人脉变化"])
    if recent_profiles:
        lines.extend(
            _obsidian_recent_profile_line(profile, filename_by_name=filename_by_name)
            for profile in recent_profiles
        )
    else:
        lines.append("- 暂无联系人档案。")
    return "\n".join(lines).rstrip() + "\n"


def _safe_markdown_filename(value: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]+', "-", value).strip(" .")
    return cleaned or "未命名联系人"


def _obsidian_manual_section(enrichment: ContactEnrichment | None = None) -> list[str]:
    fields = enrichment.fields if enrichment else {}
    lines = ["", "## 手工补充"]
    for key, label in ENRICHMENT_FIELDS:
        lines.append(f"- {label}：{fields.get(key, '')}")
    return lines


def _obsidian_recent_profile_line(profile, *, filename_by_name: dict[str, str] | None = None) -> str:
    details = [_contact_kind_label(profile.kind)]
    if profile.source_chats:
        details.append(f"来源：{_obsidian_contact_links(profile.source_chats, filename_by_name=filename_by_name)}")
    details.append(format_display_time(profile.last_seen_at))
    return f"- {_obsidian_contact_link(profile.name, filename_by_name=filename_by_name)}（{'，'.join(details)}）"


def _obsidian_profile_gap_line(
    profile,
    *,
    filename_by_name: dict[str, str] | None = None,
    enrichment: ContactEnrichment | None = None,
) -> str:
    gaps = "；".join(_profile_information_gaps(profile, enrichment=enrichment))
    return (
        f"- {_obsidian_contact_link(profile.name, filename_by_name=filename_by_name)}（{_contact_kind_label(profile.kind)}）："
        f"{gaps}；最近出现 {format_display_time(profile.last_seen_at)}"
    )


def _profile_information_gaps(profile, *, enrichment: ContactEnrichment | None = None) -> tuple[str, ...]:
    if profile.kind == "group":
        return ()
    gaps = []
    has_manual_identity = bool(
        enrichment
        and (
            enrichment.fields.get("company")
            or enrichment.fields.get("role")
            or enrichment.fields.get("context")
        )
    )
    if not profile.identity_hints and not profile.organizations and not has_manual_identity:
        gaps.append("缺少身份/机构线索（建议补充：公司/职位/角色、认识场景）")
    if profile.kind == "speaker" and not profile.source_chats:
        gaps.append("缺少来源群（建议补充：来自哪个群或渠道）")
    if not profile.recent_contents:
        gaps.append("缺少最近联系内容（建议导入最近聊天截图或手动记录一句摘要）")
    return tuple(gaps)


def _obsidian_week_label(report_date: str) -> str:
    year, week, _weekday = date.fromisoformat(report_date).isocalendar()
    return f"{year}-W{week:02d}"


def _obsidian_week_range(report_date: str) -> tuple[date, date]:
    current = date.fromisoformat(report_date)
    start = current - timedelta(days=current.weekday())
    return start, start + timedelta(days=6)


def _obsidian_contact_link(name: str, *, filename_by_name: dict[str, str] | None = None) -> str:
    stem = filename_by_name.get(name) if filename_by_name else None
    return f"[[{stem or _safe_markdown_filename(name)}|{name}]]"


def _obsidian_contact_links(names, *, filename_by_name: dict[str, str] | None = None) -> str:
    return ", ".join(_obsidian_contact_link(name, filename_by_name=filename_by_name) for name in names)


def _format_top_suggestion(suggestions) -> str:
    if not suggestions:
        return "无"
    top = suggestions[0]
    return f"{top.person_name} / {top.action} / {top.score}分 / {followup_strength_label(top.score)}"


def _format_top_draft(suggestions, *, max_length: int = 96) -> str:
    if not suggestions:
        return "无"
    draft = " ".join(suggestions[0].draft.split())
    if len(draft) <= max_length:
        return draft
    return draft[:max_length].rstrip(" ，。！？,.!?") + "..."


def _format_matching_latest(profiles) -> str:
    if not profiles:
        return "无"
    priority = {"speaker": 2, "direct": 1, "group": 0}
    latest = max(
        profiles,
        key=lambda profile: (
            profile.last_seen_at,
            priority.get(profile.kind, 0),
            profile.name,
        ),
    )
    return f"{format_display_time(latest.last_seen_at)} {latest.name}"


def _source_import_type_summary(by_type: dict[str, int]) -> str:
    return " ".join(f"{source_type}={by_type[source_type]}" for source_type in SOURCE_TYPES if by_type.get(source_type))


def _audit_table_summary(table_counts: dict[str, int]) -> str:
    return " ".join(f"{table}={count}" for table, count in table_counts.items())


def _profiles_empty_message(query: str | None) -> str:
    label = _contact_query_label(query)
    if label:
        return f"没有找到匹配「{label}」的联系人档案。"
    return "暂无联系人档案。"


def _suggestions_empty_message(query: str | None, *, min_score: int | None = None, hidden_suggestion=None) -> str:
    threshold_message = _threshold_filtered_message(query, min_score, hidden_suggestion)
    if threshold_message:
        return threshold_message
    label = _contact_query_label(query)
    if label:
        return f"没有找到匹配「{label}」的跟进建议。"
    return "暂无需要跟进的联系人。"


def _threshold_filtered_message(query: str | None, min_score: int | None, hidden_suggestion) -> str | None:
    if min_score is None or min_score <= 0 or hidden_suggestion is None:
        return None
    label = _contact_query_label(query)
    subject = f"匹配「{label}」的跟进建议" if label else "现有跟进建议"
    return (
        f"{subject}低于当前阈值 {min_score}"
        f"（最高 {hidden_suggestion.score} 分，{followup_strength_label(hidden_suggestion.score)}）。"
        "如需查看这些草稿，请降低阈值，例如 --min-score 0。"
    )


def _contacts_empty_message(query: str | None) -> str:
    label = _contact_query_label(query)
    if label:
        return f"没有找到匹配「{label}」的联系人。"
    return "暂无联系人。"


def _contact_query_label(query: str | None) -> str | None:
    if not query:
        return None
    label = query.strip()
    return label or None


def _filter_profiles(profiles, query: str | None):
    if not query:
        return profiles
    needle = query.strip().lower()
    if not needle:
        return profiles
    matched = [
        profile
        for profile in profiles
        if _matches_profile_query(profile, needle)
    ]
    normalized_needle = _normalize_contact_match_text(needle)
    return sorted(
        matched,
        key=lambda profile: _profile_match_rank(profile, needle, normalized_needle),
    )


def _pre_filter_profile_limit(query: str | None, limit: int | None) -> int | None:
    return None if _contact_query_label(query) else limit


def _post_filter_limit(items, query: str | None, limit: int | None):
    if _contact_query_label(query) and limit is not None:
        return items[:limit]
    return items


def _filter_suggestions(suggestions, query: str | None, *, matched_profiles=None):
    if not query:
        return suggestions
    needle = query.strip().lower()
    if not needle:
        return suggestions
    matched_profiles = matched_profiles or []
    normalized_needle = _normalize_contact_match_text(needle)
    exact_profiles = [
        profile
        for profile in matched_profiles
        if profile.name.lower() == needle
        or _normalize_contact_match_text(profile.name) == normalized_needle
    ]
    if exact_profiles:
        exact_names = {profile.name for profile in exact_profiles}
        exact_group_names = {profile.name for profile in exact_profiles if profile.kind == "group"}
        return [
            suggestion
            for suggestion in suggestions
            if suggestion.person_name in exact_names
            or any(source_chat in exact_group_names for source_chat in suggestion.source_chats)
        ]
    matched_names = {profile.name for profile in matched_profiles}
    matched_source_chats = {
        source_chat
        for profile in matched_profiles
        for source_chat in profile.source_chats
    }
    return [
        suggestion
        for suggestion in suggestions
        if _matches_contact_query(suggestion.person_name, suggestion.source_chats, needle)
        or suggestion.person_name in matched_names
        or any(source_chat in matched_source_chats for source_chat in suggestion.source_chats)
    ]


def _matching_profiles(db_path: Path, query: str | None):
    if not query:
        return []
    return _filter_profiles(build_profiles(db_path), query)


def _best_hidden_suggestion(db_path: Path, query: str | None, *, min_score: int, as_of: str | None = None, matched_profiles=None):
    if min_score <= 0:
        return None
    suggestions = build_suggestions(db_path, as_of=as_of, limit=1000, min_score=0)
    suggestions = _filter_suggestions(suggestions, query, matched_profiles=matched_profiles)
    hidden = [suggestion for suggestion in suggestions if suggestion.score < min_score]
    return hidden[0] if hidden else None


def _matches_contact_query(name: str, source_chats: tuple[str, ...], needle: str) -> bool:
    normalized_needle = _normalize_contact_match_text(needle)
    return _matches_contact_value(name, needle, normalized_needle) or any(
        _matches_contact_value(source, needle, normalized_needle) for source in source_chats
    )


def _matches_profile_query(profile, needle: str) -> bool:
    normalized_needle = _normalize_contact_match_text(needle)
    values = (
        profile.name,
        *profile.source_chats,
        *profile.identity_hints,
        *profile.organizations,
        *profile.links,
        *profile.files,
        *profile.recent_contents,
    )
    return any(_matches_contact_value(value, needle, normalized_needle) for value in values)


def _profile_match_rank(profile, needle: str, normalized_needle: str) -> int:
    normalized_name = _normalize_contact_match_text(profile.name)
    if profile.name.lower() == needle or normalized_name == normalized_needle:
        return 0
    if _matches_contact_value(profile.name, needle, normalized_needle):
        return 1
    if any(
        source.lower() == needle or _normalize_contact_match_text(source) == normalized_needle
        for source in profile.source_chats
    ):
        return 2
    if any(_matches_contact_value(source, needle, normalized_needle) for source in profile.source_chats):
        return 3
    clue_values = (*profile.identity_hints, *profile.organizations, *profile.links, *profile.files)
    if any(_matches_contact_value(value, needle, normalized_needle) for value in clue_values):
        return 4
    return 5


def _matches_contact_value(value: str, needle: str, normalized_needle: str) -> bool:
    if needle in value.lower():
        return True
    return bool(normalized_needle and normalized_needle in _normalize_contact_match_text(value))


def _normalize_contact_match_text(value: str) -> str:
    return "".join(character for character in value.lower() if character.isalnum())


def _render_contacts_markdown(profiles, *, query: str | None = None) -> str:
    lines = ["# 联系人索引", ""]
    if not profiles:
        return "\n".join(lines + [_contacts_empty_message(query)]) + "\n"
    lines.extend(
        [
            "| 名称 | 类型 | 来源群/会话 | 最近出现 | 线索 | 关系信号 |",
            "|---|---|---|---|---|---|",
        ]
    )
    for profile in profiles:
        lines.append(
            f"| {_markdown_cell(profile.name)} | "
            f"{_markdown_cell(_contact_kind_label(profile.kind))} | "
            f"{_markdown_cell(', '.join(profile.source_chats))} | "
            f"{_markdown_cell(format_display_time(profile.last_seen_at))} | "
            f"{_markdown_cell(_contact_clues(profile))} | "
            f"{_markdown_cell(', '.join(signal_label(signal) for signal in profile.signals))} |"
        )
    return "\n".join(lines) + "\n"


def _render_brief_markdown(
    profiles,
    suggestions,
    *,
    query: str,
    evidence: BriefEvidence | None = None,
    no_suggestion_message: str | None = None,
) -> str:
    if not profiles:
        return _contacts_empty_message(query) + "\n"
    profile = profiles[0]
    lines = [
        f"# 联系人简报：{profile.name}",
        "",
        f"- 类型：{_contact_kind_label(profile.kind)}",
        f"- 最近出现：{format_display_time(profile.last_seen_at)}",
    ]
    if profile.source_chats:
        lines.append(f"- 来源群/会话：{', '.join(profile.source_chats)}")
    if profile.speakers:
        lines.append(f"- 近期发言人：{', '.join(profile.speakers)}")
    if profile.identity_hints:
        lines.append(f"- 身份线索：{', '.join(profile.identity_hints)}")
    if profile.organizations:
        lines.append(f"- 机构/公司：{', '.join(profile.organizations)}")
    if profile.signals:
        lines.append(f"- 关系信号：{', '.join(signal_label(signal) for signal in profile.signals)}")
    if profile.links:
        lines.append(f"- 链接：{', '.join(profile.links)}")
    if profile.files:
        lines.append(f"- 文件：{', '.join(profile.files)}")

    if len(profiles) > 1:
        lines.extend(["", "## 匹配到的联系人"])
        for matched_profile in profiles[:8]:
            lines.append(f"- {_brief_match_label(matched_profile)}")
        if len(profiles) > 8:
            lines.append(f"- 另有 {len(profiles) - 8} 个匹配")

    lines.extend(["", "## 最近联系内容"])
    if profile.recent_contents:
        for item in profile.recent_contents[:5]:
            lines.append(f"- {item}")
    else:
        lines.append("暂无最近联系内容。")

    if evidence:
        lines.extend(
            [
                "",
                "## 最近采集证据",
                f"- 会话：{evidence.chat_name}",
                f"- 采集时间：{format_display_time(evidence.captured_at)}",
                f"- 来源：{evidence.source}",
            ]
        )
        if evidence.image_path:
            lines.append(f"- 截图：{evidence.image_path}")

    lines.extend(["", "## 下一步"])
    if suggestions:
        top = suggestions[0]
        lines.extend(
            [
                f"- 建议对象：{top.person_name}",
                f"- 动作：{top.action}",
                f"- 分数：{top.score}",
                f"- 跟进强度：{followup_strength_label(top.score)}",
                f"- 最近互动：{format_display_time(top.last_interaction_at)}",
                f"- 原因：{top.why}",
                "",
                f"草稿：{top.draft}",
            ]
        )
    else:
        lines.append(no_suggestion_message or "暂无匹配跟进建议。")
    return "\n".join(lines).rstrip() + "\n"


def _brief_evidence(
    db_path: Path,
    profile,
    *,
    preferred_captured_at: str | None = None,
) -> BriefEvidence | None:
    chat_names = tuple(profile.source_chats) if profile.kind == "speaker" and profile.source_chats else (profile.name,)
    placeholders = ", ".join("?" for _ in chat_names)
    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            select p.name as chat_name, c.captured_at, c.source, c.image_path,
                   coalesce(c.corrected_text, c.clean_text) as clean_text
            from captures c
            join people p on p.id = c.person_id
            where p.name in ({placeholders})
            order by c.captured_at desc, c.id desc
            """,
            list(chat_names),
        ).fetchall()
    if profile.kind == "speaker":
        speaker_rows = []
        for row in rows:
            if profile.name in extract_speakers(row["clean_text"].splitlines(), chat_name=row["chat_name"]):
                speaker_rows.append(row)
        if preferred_captured_at:
            for row in speaker_rows:
                if row["captured_at"] == preferred_captured_at:
                    return _brief_evidence_from_row(row)
        return _brief_evidence_from_row(speaker_rows[0]) if speaker_rows else None
    if not rows:
        return None
    if preferred_captured_at:
        for row in rows:
            if row["captured_at"] == preferred_captured_at:
                return _brief_evidence_from_row(row)
    return _brief_evidence_from_row(rows[0])


def _evidence_for_suggestion(db_path: Path, suggestion) -> BriefEvidence | None:
    profiles = _filter_profiles(build_profiles(db_path), suggestion.person_name)
    if not profiles:
        return None
    normalized_name = _normalize_contact_match_text(suggestion.person_name)
    exact_profiles = [
        profile
        for profile in profiles
        if profile.name == suggestion.person_name
        or _normalize_contact_match_text(profile.name) == normalized_name
    ]
    if suggestion.source_chats:
        for profile in exact_profiles:
            if any(source_chat in profile.source_chats for source_chat in suggestion.source_chats):
                return _brief_evidence(
                    db_path,
                    profile,
                    preferred_captured_at=getattr(suggestion, "evidence_captured_at", None),
                )
    if exact_profiles:
        return _brief_evidence(
            db_path,
            exact_profiles[0],
            preferred_captured_at=getattr(suggestion, "evidence_captured_at", None),
        )
    return _brief_evidence(
        db_path,
        profiles[0],
        preferred_captured_at=getattr(suggestion, "evidence_captured_at", None),
    )


def _brief_display_evidence(db_path: Path, profiles, suggestions) -> BriefEvidence | None:
    if suggestions:
        return _evidence_for_suggestion(db_path, suggestions[0])
    if profiles:
        return _brief_evidence(db_path, profiles[0])
    return None


def _brief_evidence_from_row(row) -> BriefEvidence:
    return BriefEvidence(
        chat_name=row["chat_name"],
        captured_at=row["captured_at"],
        source=row["source"],
        image_path=row["image_path"],
    )


def _brief_no_suggestion_message(query: str, *, min_score: int, hidden_suggestion) -> str:
    return _threshold_filtered_message(query, min_score, hidden_suggestion) or "暂无匹配跟进建议。"


def _brief_match_label(profile) -> str:
    details = [_contact_kind_label(profile.kind)]
    if profile.source_chats:
        details.append(f"来源：{', '.join(profile.source_chats)}")
    clues = _contact_clues(profile)
    if clues:
        details.append(f"线索：{clues}")
    return f"{profile.name}（{'，'.join(details)}）"


def _contact_clues(profile) -> str:
    clues: list[str] = []
    for value in (*profile.identity_hints, *profile.organizations):
        if value not in clues:
            clues.append(value)
    return ", ".join(clues)


def _contact_kind_label(kind: str) -> str:
    return {
        "group": "群聊",
        "direct": "私聊/单聊",
        "speaker": "群内联系人",
        "manual": "手工补充",
        "source": "多入口来源",
    }.get(kind, kind)


def _markdown_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", "<br>")


def cmd_watch(args: argparse.Namespace) -> int:
    log_state = WatchLogState()
    _log_watch(args, "start", "watching frontmost WeChat window; press Ctrl-C to stop", app_name="-")
    while True:
        status = frontmost_app_status()
        app_name = status.name
        if app_name and app_name in args.app:
            try:
                outcome = _capture_once(args)
                print(outcome.output_line)
                _log_watch(
                    args,
                    "capture",
                    f"{outcome.log_detail} via {status.method}",
                    app_name=app_name,
                    state=log_state,
                )
            except (CaptureError, EmptyCaptureError) as exc:
                _log_watch(args, "error", str(exc), app_name=app_name, state=log_state)
        else:
            detail = f"{status.detail} via {status.method}" if not app_name else f"not target app via {status.method}"
            _log_watch(args, "skip", detail, app_name=app_name or "unknown", state=log_state)
        time.sleep(max(5, _watch_interval(args)))


def _read_text(args: argparse.Namespace) -> str:
    if args.text and args.text_file:
        raise SystemExit("Use --text or --text-file, not both.")
    if args.text_file:
        return args.text_file.read_text(encoding="utf-8")
    if args.text:
        return args.text
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise SystemExit("Provide --text, --text-file, or pipe text via stdin.")


def _remove_duplicate_image(image_path: Path) -> bool:
    try:
        image_path.unlink()
    except FileNotFoundError:
        return False
    return True


def _display_settings_path(db_path: Path) -> str:
    path = settings_path_for_db(db_path)
    if Path(db_path).parent.name == "data":
        return str(Path("data") / path.name)
    return str(path)


def _watch_interval(args: argparse.Namespace) -> int:
    if args.interval is not None:
        return args.interval
    return load_settings(args.db).watch_interval_seconds


def _log_watch(
    args: argparse.Namespace,
    action: str,
    detail: str,
    *,
    app_name: str,
    state: WatchLogState | None = None,
) -> None:
    if state is not None and not _should_emit_watch_log(
        state,
        action=action,
        app_name=app_name,
        detail=detail,
        quiet_skip_every=max(1, getattr(args, "quiet_skip_every", 30)),
    ):
        return
    line = _watch_log_line(now_iso(), app_name=app_name, action=action, detail=detail)
    print(line, file=sys.stderr, flush=True)
    _append_watch_log(args.log_file, line)


def _should_emit_watch_log(
    state: WatchLogState,
    *,
    action: str,
    app_name: str,
    detail: str,
    quiet_skip_every: int,
) -> bool:
    key = (action, app_name, detail)
    if action != "skip":
        state.last_key = None
        state.repeat_count = 0
        return True
    if key != state.last_key:
        state.last_key = key
        state.repeat_count = 1
        return True
    state.repeat_count += 1
    return state.repeat_count % max(1, quiet_skip_every) == 1


def _watch_log_line(timestamp: str, *, app_name: str, action: str, detail: str) -> str:
    return f"{timestamp} app={_log_value(app_name)} action={_log_value(action)} detail={_log_value(detail)}"


def _append_watch_log(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line)
        handle.write("\n")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _log_value(value: str) -> str:
    return " ".join(str(value).split())


def _format_signal_kinds(signal_kinds: tuple[str, ...]) -> str:
    return ",".join(signal_label(signal) for signal in signal_kinds) or "无"


if __name__ == "__main__":
    raise SystemExit(main())
