from __future__ import annotations

import argparse
import hashlib
import getpass
import json
import mimetypes
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path


PASSPHRASE_HELP = (
    "automation only: a passphrase given here is visible in shell history and ps; "
    "prefer the interactive prompt or HEALTHCARE_PASSPHRASE"
)

from .daemon import LocalHealthDaemon
from .benchmark import run_benchmark
from .control import ControlSession
from .decoder import DecoderError, decode_file, page_digest
from .ingest import ImportBoundaryError, read_control_selected_text
from .trust import MacOSKeychain, TrustManager
from .vault import VaultError, VaultStore


def _passphrase(args: argparse.Namespace) -> str:
    if args.passphrase:
        return args.passphrase
    value = os.environ.get("HEALTHCARE_PASSPHRASE")
    if value:
        return value
    return getpass.getpass("Vault passphrase: ")


def _add_vault_arg(parser: argparse.ArgumentParser) -> None:
    """--vault falls back to $HEALTHCARE_VAULT so wrappers can supply it once."""
    default = os.environ.get("HEALTHCARE_VAULT")
    parser.add_argument(
        "--vault",
        type=Path,
        default=Path(default) if default else None,
        required=default is None,
        help="path to the Vault (default: $HEALTHCARE_VAULT)",
    )


def _store(args: argparse.Namespace) -> VaultStore:
    return VaultStore.open(Path(args.vault), _passphrase(args))


def _print(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="healthcare", description="healthCare local Control CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="create an encrypted pilot Vault")
    _add_vault_arg(init)
    init.add_argument("--passphrase", help=PASSPHRASE_HELP)

    import_text = sub.add_parser("import-text", help="import one supported text report")
    _add_vault_arg(import_text)
    import_text.add_argument("--passphrase", help=PASSPHRASE_HELP)
    import_text.add_argument("--person")
    import_text.add_argument("--quarantine", action="store_true", help="import without assigning a patient")
    import_text.add_argument("--display-name")
    import_text.add_argument("--file", required=True, type=Path)
    import_text.add_argument("--report-date")

    import_file = sub.add_parser("import-file", help="decode and import a text, image, or digital PDF report")
    _add_vault_arg(import_file)
    import_file.add_argument("--passphrase", help=PASSPHRASE_HELP)
    import_file.add_argument("--person")
    import_file.add_argument("--quarantine", action="store_true")
    import_file.add_argument("--display-name")
    import_file.add_argument("--file", required=True, type=Path)
    import_file.add_argument("--report-date")
    import_file.add_argument("--idempotency-key")
    import_file.add_argument("--request-id", help="fulfill an Agent import request in quarantine")
    import_file.add_argument("--ocr-engine", choices=("vision", "tesseract"), default="vision")
    import_file.add_argument("--ocr-command", default="healthcare-vision-ocr")
    import_file.add_argument("--ocr-language", action="append", dest="ocr_languages")
    import_file.add_argument("--no-sandbox", action="store_true", help="development-only: disable decoder sandbox")

    review = sub.add_parser("review-job", help="confirm extraction candidates in Control")
    _add_vault_arg(review)
    review.add_argument("--passphrase", help=PASSPHRASE_HELP)
    review.add_argument("--job", required=True)
    review.add_argument("--accept-all", action="store_true")
    review.add_argument("--field")
    review.add_argument("--value", type=float)
    review.add_argument("--unit", help="canonical unit supplied together with --value (unmapped-unit correction)")

    grant_consent = sub.add_parser("grant-consent", help="issue a standing consent for an Agent over a person")
    _add_vault_arg(grant_consent)
    grant_consent.add_argument("--passphrase", help=PASSPHRASE_HELP)
    grant_consent.add_argument("--agent", required=True)
    grant_consent.add_argument("--person", required=True)
    grant_consent.add_argument("--scope", required=True)
    grant_consent.add_argument("--purpose", required=True)
    grant_consent.add_argument("--ttl-days", type=int)

    revoke_consent = sub.add_parser("revoke-consent", help="revoke a standing consent grant")
    _add_vault_arg(revoke_consent)
    revoke_consent.add_argument("--passphrase", help=PASSPHRASE_HELP)
    revoke_consent.add_argument("--grant", required=True)

    list_consents = sub.add_parser("list-consents", help="list standing consent grants")
    _add_vault_arg(list_consents)
    list_consents.add_argument("--passphrase", help=PASSPHRASE_HELP)
    list_consents.add_argument("--agent")

    verify_audit = sub.add_parser("verify-audit", help="verify the tamper-evident audit hash chain")
    _add_vault_arg(verify_audit)
    verify_audit.add_argument("--passphrase", help=PASSPHRASE_HELP)

    record_vital = sub.add_parser("record-vital", help="record one daily vital reading (blood pressure and/or body weight)")
    _add_vault_arg(record_vital)
    record_vital.add_argument("--passphrase", help=PASSPHRASE_HELP)
    record_vital.add_argument("--person", required=True)
    record_vital.add_argument("--measured-at", required=True)
    record_vital.add_argument("--systolic", type=int)
    record_vital.add_argument("--diastolic", type=int)
    record_vital.add_argument("--heart-rate", type=int)
    record_vital.add_argument("--weight", type=float, help="body weight in kg")
    record_vital.add_argument("--note")

    record_med = sub.add_parser("record-medication", help="record one medication intake event")
    _add_vault_arg(record_med)
    record_med.add_argument("--passphrase", help=PASSPHRASE_HELP)
    record_med.add_argument("--person", required=True)
    record_med.add_argument("--taken-at", required=True)
    record_med.add_argument("--medication", required=True)
    record_med.add_argument("--dose")
    record_med.add_argument("--unit")
    record_med.add_argument("--missed", action="store_true", help="mark as not taken")
    record_med.add_argument("--note")
    record_med.add_argument("--plan", help="optional user-confirmed medication plan id; does not change the plan")

    edit_record = sub.add_parser("edit-record", help="edit one health record by type and id; omitted fields stay unchanged")
    _add_vault_arg(edit_record)
    edit_record.add_argument("--passphrase", help=PASSPHRASE_HELP)
    edit_record.add_argument("--person", required=True)
    edit_record.add_argument("--type", choices=["vital", "medication", "activity", "emotion", "sleep", "observation"], required=True)
    edit_record.add_argument("--record-id", required=True)
    edit_record.add_argument("--changes", required=True, help="JSON object of changed fields; null clears optional fields")
    delete_record = sub.add_parser("delete-record", help="delete one health record by type and id behind a Control approval grant; audit keeps the removed snapshot")
    _add_vault_arg(delete_record)
    delete_record.add_argument("--passphrase", help=PASSPHRASE_HELP)
    delete_record.add_argument("--person", required=True)
    delete_record.add_argument("--type", choices=["vital", "medication", "activity", "emotion", "sleep", "observation"], required=True)
    delete_record.add_argument("--record-id", required=True)

    edit_med = sub.add_parser("edit-medication", help="edit one medication intake record by id")
    _add_vault_arg(edit_med)
    edit_med.add_argument("--passphrase", help=PASSPHRASE_HELP)
    edit_med.add_argument("--person", required=True)
    edit_med.add_argument("--record-id", required=True)
    edit_med.add_argument("--taken-at")
    edit_med.add_argument("--medication")
    edit_med.add_argument("--dose")
    edit_med.add_argument("--unit")
    edit_med.add_argument("--note")
    edit_med.add_argument("--clear-dose", action="store_true")
    edit_med.add_argument("--clear-unit", action="store_true")
    edit_med.add_argument("--clear-note", action="store_true")
    taken_state = edit_med.add_mutually_exclusive_group()
    taken_state.add_argument("--taken", dest="taken", action="store_true")
    taken_state.add_argument("--missed", dest="taken", action="store_false")
    edit_med.set_defaults(taken=None)

    record_act = sub.add_parser("record-activity", help="record one exercise/activity session")
    _add_vault_arg(record_act)
    record_act.add_argument("--passphrase", help=PASSPHRASE_HELP)
    record_act.add_argument("--person", required=True)
    record_act.add_argument("--date", required=True)
    record_act.add_argument("--activity-type", required=True)
    record_act.add_argument("--duration", type=float)
    record_act.add_argument("--distance", type=float)
    record_act.add_argument("--steps", type=int)
    record_act.add_argument("--note")

    record_emotion = sub.add_parser("record-emotion", help="record one emotion with duration, feelings and reflection")
    _add_vault_arg(record_emotion)
    record_emotion.add_argument("--passphrase", help=PASSPHRASE_HELP)
    record_emotion.add_argument("--person", required=True)
    record_emotion.add_argument("--occurred-at", required=True)
    record_emotion.add_argument("--name", required=True)
    record_emotion.add_argument("--duration", type=float, help="emotion duration in minutes")
    record_emotion.add_argument("--feelings", help="felt experience, including bodily or emotional sensations")
    record_emotion.add_argument("--reflection", help="insight or reflection associated with the emotion")

    record_sleep = sub.add_parser("record-sleep", help="record one night's sleep; --date is the wake-up date")
    _add_vault_arg(record_sleep)
    record_sleep.add_argument("--passphrase", help=PASSPHRASE_HELP)
    record_sleep.add_argument("--person", required=True)
    record_sleep.add_argument("--date", required=True, help="wake-up date (YYYY-MM-DD); the night before belongs to it")
    record_sleep.add_argument("--duration", type=float, help="total sleep in minutes; derived from --bedtime/--wake-time when omitted")
    record_sleep.add_argument("--bedtime", help="local time the user went to sleep (HH:MM)")
    record_sleep.add_argument("--wake-time", help="local time the user got up (HH:MM)")
    record_sleep.add_argument("--quality", type=int, choices=range(1, 6), metavar="{1,2,3,4,5}", help="subjective sleep quality")
    record_sleep.add_argument("--note")

    encounter = sub.add_parser("record-encounter", help="record one healthcare encounter without inferring a diagnosis")
    _add_vault_arg(encounter)
    encounter.add_argument("--passphrase", help=PASSPHRASE_HELP)
    encounter.add_argument("--person", required=True)
    encounter.add_argument("--occurred-on", required=True)
    encounter.add_argument("--facility")
    encounter.add_argument("--department")
    encounter.add_argument("--type", choices=("outpatient", "inpatient", "emergency", "checkup", "telehealth", "other"), default="other")
    encounter.add_argument("--note")
    encounter.add_argument("--document", action="append", dest="document_ids")

    diagnosis = sub.add_parser("record-diagnosis-mention", help="record verbatim diagnosis wording and its source context")
    _add_vault_arg(diagnosis)
    diagnosis.add_argument("--passphrase", help=PASSPHRASE_HELP)
    diagnosis.add_argument("--person", required=True)
    diagnosis.add_argument("--text", required=True)
    diagnosis.add_argument("--context", required=True, choices=("current", "suspected", "ruled_out", "history", "family_history", "other"))
    diagnosis.add_argument("--occurred-on")
    diagnosis.add_argument("--encounter")
    diagnosis.add_argument("--document")
    diagnosis.add_argument("--evidence")

    medication_plan = sub.add_parser("create-medication-plan", help="create a draft or explicitly confirmed medication plan")
    _add_vault_arg(medication_plan)
    medication_plan.add_argument("--passphrase", help=PASSPHRASE_HELP)
    medication_plan.add_argument("--person", required=True)
    medication_plan.add_argument("--medication", required=True)
    medication_plan.add_argument("--schedule", required=True, help="user-confirmed timing text, e.g. 每日 08:00")
    medication_plan.add_argument("--dose")
    medication_plan.add_argument("--unit")
    medication_plan.add_argument("--route")
    medication_plan.add_argument("--starts-on")
    medication_plan.add_argument("--ends-on")
    medication_plan.add_argument("--source-document")
    medication_plan.add_argument("--source-evidence")
    medication_plan.add_argument("--activate", action="store_true", help="activate only with --confirm-plan")
    medication_plan.add_argument("--confirm-plan", action="store_true", help="explicitly confirm this plan against the user's record or medical order")

    edit_medication_plan = sub.add_parser("edit-medication-plan", help="edit one medication plan in local Control")
    _add_vault_arg(edit_medication_plan)
    edit_medication_plan.add_argument("--passphrase", help=PASSPHRASE_HELP)
    edit_medication_plan.add_argument("--person", required=True)
    edit_medication_plan.add_argument("--plan", required=True)
    edit_medication_plan.add_argument("--changes", required=True, help="JSON object; activating a plan requires user_confirmed=true")

    reminder = sub.add_parser("create-reminder", help="create a deterministic record, plan, or follow-up reminder")
    _add_vault_arg(reminder)
    reminder.add_argument("--passphrase", help=PASSPHRASE_HELP)
    reminder.add_argument("--person", required=True)
    reminder.add_argument("--kind", required=True, choices=("record", "medication_plan", "followup"))
    reminder.add_argument("--schedule", required=True)
    reminder.add_argument("--title", required=True)
    reminder.add_argument("--medication-plan")
    reminder.add_argument("--due-on")
    reminder.add_argument("--timezone", default="local")
    reminder.add_argument("--quiet-start")
    reminder.add_argument("--quiet-end")

    list_encounters = sub.add_parser("encounters", help="list recorded healthcare encounters")
    _add_vault_arg(list_encounters)
    list_encounters.add_argument("--passphrase", help=PASSPHRASE_HELP)
    list_encounters.add_argument("--person", required=True)

    list_diagnoses = sub.add_parser("diagnoses", help="list verbatim diagnosis mentions")
    _add_vault_arg(list_diagnoses)
    list_diagnoses.add_argument("--passphrase", help=PASSPHRASE_HELP)
    list_diagnoses.add_argument("--person", required=True)

    list_plans = sub.add_parser("medication-plans", help="list medication plans separately from intake events")
    _add_vault_arg(list_plans)
    list_plans.add_argument("--passphrase", help=PASSPHRASE_HELP)
    list_plans.add_argument("--person", required=True)

    list_reminders = sub.add_parser("reminders", help="list active reminder rules")
    _add_vault_arg(list_reminders)
    list_reminders.add_argument("--passphrase", help=PASSPHRASE_HELP)
    list_reminders.add_argument("--person", required=True)
    list_reminders.add_argument("--include-paused", action="store_true")

    due_reminders = sub.add_parser("reminders-due", help="evaluate deterministic local reminder rules without sending a notification")
    _add_vault_arg(due_reminders)
    due_reminders.add_argument("--passphrase", help=PASSPHRASE_HELP)
    due_reminders.add_argument("--person", required=True)
    due_reminders.add_argument("--at", help="ISO datetime for a deterministic evaluation; defaults to local current time")

    complete_reminder = sub.add_parser("complete-reminder", help="mark one generated reminder instance completed; this does not imply a medication was taken")
    _add_vault_arg(complete_reminder)
    complete_reminder.add_argument("--passphrase", help=PASSPHRASE_HELP)
    complete_reminder.add_argument("--person", required=True)
    complete_reminder.add_argument("--occurrence", required=True)

    set_reminder = sub.add_parser("set-reminder-status", help="pause, activate, or cancel a reminder rule")
    _add_vault_arg(set_reminder)
    set_reminder.add_argument("--passphrase", help=PASSPHRASE_HELP)
    set_reminder.add_argument("--person", required=True)
    set_reminder.add_argument("--rule", required=True)
    set_reminder.add_argument("--status", required=True, choices=("active", "paused", "cancelled"))

    trend = sub.add_parser("trend", help="calculate a deterministic, source-linked trend summary")
    _add_vault_arg(trend)
    trend.add_argument("--passphrase", help=PASSPHRASE_HELP)
    trend.add_argument("--person", required=True)
    trend.add_argument("--source", required=True, choices=("observation", "vital"))
    trend.add_argument("--field", required=True)
    trend.add_argument("--start")
    trend.add_argument("--end")

    visit_summary = sub.add_parser("visit-summary", help="prepare a source-linked draft for a healthcare visit")
    _add_vault_arg(visit_summary)
    visit_summary.add_argument("--passphrase", help=PASSPHRASE_HELP)
    visit_summary.add_argument("--person", required=True)
    visit_summary.add_argument("--start")
    visit_summary.add_argument("--end")
    visit_summary.add_argument("--output", type=Path, help="write the user-reviewed draft to a local Markdown file")

    import_csv = sub.add_parser("import-csv", help="import a Hermes-maintained daily health CSV (blood-pressure/weight/medication/exercise)")
    _add_vault_arg(import_csv)
    import_csv.add_argument("--passphrase", help=PASSPHRASE_HELP)
    import_csv.add_argument("--type", required=True, choices=("blood-pressure", "weight", "medication", "exercise"))
    import_csv.add_argument("--file", required=True, type=Path)
    import_csv.add_argument("--person", required=True)
    import_csv.add_argument("--display-name")
    import_csv.add_argument("--idempotency-key")

    llm_extract = sub.add_parser("llm-extract", help="extract fields from a low-quality report image via a remote LLM")
    _add_vault_arg(llm_extract)
    llm_extract.add_argument("--passphrase", help=PASSPHRASE_HELP)
    llm_extract.add_argument("--image", required=True, type=Path)
    llm_extract.add_argument("--person")
    llm_extract.add_argument(
        "--consent-remote",
        action="store_true",
        help="explicit consent: the image (personal health data) is sent to a remote LLM",
    )
    llm_extract.add_argument("--endpoint")
    llm_extract.add_argument("--model")
    llm_extract.add_argument("--display-name")
    llm_extract.add_argument(
        "--report-date",
        help="report date confirmed by the user; omit when unknown so it cannot enter a trend",
    )

    re_extract = sub.add_parser("re-extract", help="regenerate candidates for a document with the current parser")
    _add_vault_arg(re_extract)
    re_extract.add_argument("--passphrase", help=PASSPHRASE_HELP)
    re_extract.add_argument("--document", required=True)

    assign = sub.add_parser("assign-document", help="confirm a quarantined document's patient in Control")
    _add_vault_arg(assign)
    assign.add_argument("--passphrase", help=PASSPHRASE_HELP)
    assign.add_argument("--document", required=True)
    assign.add_argument("--person", required=True)

    timeline = sub.add_parser("timeline", help="print confirmed lab observations")
    _add_vault_arg(timeline)
    timeline.add_argument("--passphrase", help=PASSPHRASE_HELP)
    timeline.add_argument("--person", required=True)
    timeline.add_argument(
        "--field",
        help="lab-observation field name (e.g. creatinine); "
        "for daily blood-pressure/medication/exercise records use 'recent' instead",
    )
    timeline.add_argument("--days", type=int, help="only observations measured within the last N days (today inclusive)")

    recent = sub.add_parser(
        "recent",
        help="print vitals/medications/activities/emotions/sleep from the last N days (post-record verification)",
    )
    _add_vault_arg(recent)
    recent.add_argument("--passphrase", help=PASSPHRASE_HELP)
    recent.add_argument("--person", required=True)
    recent.add_argument("--days", type=int, default=7, help="look-back window in days, today inclusive (default: 7)")

    evidence = sub.add_parser("evidence", help="print source evidence for one observation")
    _add_vault_arg(evidence)
    evidence.add_argument("--passphrase", help=PASSPHRASE_HELP)
    evidence.add_argument("--person", required=True)
    evidence.add_argument("--observation", required=True)

    export = sub.add_parser("export", help="export confirmed records from Control")
    _add_vault_arg(export)
    export.add_argument("--passphrase", help=PASSPHRASE_HELP)
    export.add_argument("--person", required=True)
    export.add_argument("--output", required=True, type=Path)
    export.add_argument("--export-passphrase")
    export.add_argument("--plaintext", action="store_true")
    export.add_argument("--confirm", action="store_true", help="confirm that plaintext leaves Vault protection")

    benchmark = sub.add_parser("benchmark", help="run a deterministic Golden report benchmark")
    benchmark.add_argument("--golden", required=True, type=Path)

    decode = sub.add_parser("decode-file", help="inspect a selected file through the bounded decoder")
    decode.add_argument("--file", required=True, type=Path)
    decode.add_argument("--ocr-engine", choices=("vision", "tesseract"), default="vision")
    decode.add_argument("--ocr-command", default="healthcare-vision-ocr")
    decode.add_argument("--ocr-language", action="append", dest="ocr_languages")
    decode.add_argument("--no-sandbox", action="store_true", help="development-only: disable decoder sandbox")

    session = sub.add_parser("issue-session", help="issue a short-lived read-only A0 capability")
    _add_vault_arg(session)
    session.add_argument("--passphrase", help=PASSPHRASE_HELP)
    session.add_argument("--person", required=True)
    session.add_argument("--host-id", required=True)
    session.add_argument("--scope", action="append", dest="scopes", default=["observations.read"])
    session.add_argument("--ttl-seconds", type=int, default=600)
    session.add_argument("--output", required=True, type=Path)
    session.add_argument(
        "--expected-exec-digest",
        help="SHA-256 of the adapter executable that may use this capability; "
        "the broker verifies it against the connecting process",
    )

    pair = sub.add_parser("pair-agent", help="pair a read-only Agent in the macOS Keychain")
    _add_vault_arg(pair)
    pair.add_argument("--passphrase", help=PASSPHRASE_HELP)
    pair.add_argument("--display-name", required=True)
    pair.add_argument("--host-id", required=True)
    pair.add_argument("--executable-digest", required=True)
    pair.add_argument("--person", action="append", dest="person_ids", required=True)
    pair.add_argument("--scope", action="append", dest="scopes", default=["observations.read"])

    revoke = sub.add_parser("revoke-agent", help="revoke one paired Agent")
    _add_vault_arg(revoke)
    revoke.add_argument("--passphrase", help=PASSPHRASE_HELP)
    revoke.add_argument("--agent-id", required=True)

    agents = sub.add_parser("list-agents", help="list paired Agent profiles")
    _add_vault_arg(agents)
    agents.add_argument("--passphrase", help=PASSPHRASE_HELP)

    backup = sub.add_parser("backup", help="write an independently encrypted backup")
    _add_vault_arg(backup)
    backup.add_argument("--passphrase", help=PASSPHRASE_HELP)
    backup.add_argument("--backup-passphrase", required=True)
    backup.add_argument("--output", required=True, type=Path)

    restore = sub.add_parser("restore", help="restore an encrypted backup")
    restore.add_argument("--backup", required=True, type=Path)
    restore.add_argument("--backup-passphrase", required=True)
    restore.add_argument("--output", required=True, type=Path)
    restore.add_argument("--confirm", required=True, choices=("RESTORE_VAULT",))
    restore.add_argument("--replace", action="store_true", help="overwrite an existing destination vault and its stale objects")

    rotate = sub.add_parser("rotate-key", help="rotate the Vault passphrase in Control")
    _add_vault_arg(rotate)
    rotate.add_argument("--passphrase", help=PASSPHRASE_HELP)
    rotate.add_argument("--new-passphrase")

    erase = sub.add_parser("crypto-erase", help="irreversibly erase a Vault and its source objects")
    _add_vault_arg(erase)
    erase.add_argument("--passphrase", help=PASSPHRASE_HELP)
    erase.add_argument("--confirm", required=True, choices=("ERASE_VAULT",))

    daemon = sub.add_parser("daemon", help="run the authenticated local IPC daemon")
    _add_vault_arg(daemon)
    daemon.add_argument("--passphrase", help=PASSPHRASE_HELP)
    daemon.add_argument("--socket", required=True, type=Path)

    workbuddy_configure = sub.add_parser("workbuddy-configure", help="write a 0600 local WorkBuddy pairing configuration without secrets")
    workbuddy_configure.add_argument("--socket", required=True, type=Path)
    workbuddy_configure.add_argument("--agent-id", required=True)
    workbuddy_configure.add_argument("--host-id", required=True)
    workbuddy_configure.add_argument("--person", required=True)
    workbuddy_configure.add_argument("--output", type=Path)
    workbuddy_configure.add_argument("--replace", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "init":
            store = VaultStore.create(args.vault, _passphrase(args))
            _print({"status": "created", "vault": str(store.path), "mode": "encrypted-pilot"})
            return 0
        if args.command == "import-text":
            if bool(args.person) == args.quarantine:
                raise VaultError("provide exactly one of --person or --quarantine")
            store = _store(args)
            try:
                selected = read_control_selected_text(args.file)
            except ImportBoundaryError as exc:
                raise VaultError(str(exc)) from exc
            report = selected.text
            if args.person:
                store.ensure_person(args.person, args.display_name)
                job = store.import_text(args.person, selected.filename, report, args.report_date)
            else:
                job = store.import_text_unassigned(selected.filename, report, args.report_date)
            candidates = [store.state["candidates"][candidate_id] for candidate_id in job.candidate_ids]
            _print({"job": job.__dict__ if hasattr(job, "__dict__") else {
                "id": job.id, "person_id": job.person_id, "document_id": job.document_id,
                "status": job.status, "candidate_ids": job.candidate_ids,
            }, "candidates": candidates})
            return 0
        if args.command == "import-file":
            if args.request_id and (args.person or args.quarantine):
                raise VaultError("--request-id cannot be combined with --person or --quarantine")
            if not args.request_id and bool(args.person) == args.quarantine:
                raise VaultError("provide exactly one of --person or --quarantine")
            store = _store(args)
            document = decode_file(
                args.file,
                tuple(args.ocr_languages or ("chi_sim", "eng")),
                ocr_engine=args.ocr_engine,
                ocr_command=args.ocr_command,
                sandbox=False if args.no_sandbox else None,
            )
            if args.request_id:
                job = store.fulfill_import_request(
                    args.request_id,
                    document,
                    source_bytes=args.file.read_bytes(),
                )
            else:
                if args.person:
                    store.ensure_person(args.person, args.display_name)
                job = store.import_decoded_document(
                    args.person,
                    document,
                    report_date=args.report_date,
                    idempotency_key=args.idempotency_key,
                    source_bytes=args.file.read_bytes(),
                )
            candidates = [store.state["candidates"][candidate_id] for candidate_id in job.candidate_ids]
            _print({
                "job": {
                    "id": job.id,
                    "person_id": job.person_id,
                    "document_id": job.document_id,
                    "status": job.status,
                    "candidate_ids": job.candidate_ids,
                },
                "document": {
                    "filename": document.filename,
                    "media_type": document.media_type,
                    "decoder": document.decoder,
                    "page_count": len(document.pages),
                },
                "candidates": candidates,
            })
            return 0
        if args.command == "grant-consent":
            store = _store(args)
            store.ensure_person(args.person)
            grant = store.issue_consent_grant(args.agent, args.person, args.scope, args.purpose, args.ttl_days)
            _print({"status": "granted", "grant_id": grant.id, "agent": args.agent, "person": args.person, "scope": args.scope, "expires_at": grant.expires_at})
            return 0
        if args.command == "revoke-consent":
            grant = _store(args).revoke_consent_grant(args.grant)
            _print({"status": "revoked", "grant_id": grant.id, "revoked_at": grant.revoked_at})
            return 0
        if args.command == "list-consents":
            store = _store(args)
            grants = store.active_consent_grants(agent_id=args.agent)
            _print(grants)
            return 0
        if args.command == "verify-audit":
            store = _store(args)
            valid = store.verify_audit_chain()
            _print({
                "status": "valid" if valid else "tampered",
                "audit_events": len(store.state["audit_events"]),
            })
            return 0 if valid else 2
        if args.command == "record-vital":
            store = _store(args)
            store.ensure_person(args.person)
            added = store.record_vital(
                args.person, args.measured_at, args.systolic, args.diastolic, args.heart_rate,
                weight_kg=args.weight, note=args.note,
            )
            store.save()
            _print({"status": "recorded" if added else "duplicate", "type": "vital", "measured_at": args.measured_at})
            return 0
        if args.command == "record-medication":
            store = _store(args)
            store.ensure_person(args.person)
            added = store.record_medication(
                args.person, args.taken_at, args.medication, args.dose, args.unit,
                taken=not args.missed, note=args.note, medication_plan_id=args.plan,
            )
            store.save()
            _print({"status": "recorded" if added else "duplicate", "type": "medication", "medication": args.medication})
            return 0
        if args.command == "edit-record":
            try:
                changes = json.loads(args.changes)
            except ValueError as exc:
                raise VaultError("--changes must be valid JSON") from exc
            store = _store(args)
            if not ControlSession(store).update_record(args.person, args.type, args.record_id, changes):
                raise VaultError("record not found for this person")
            store.save()
            _print({"status": "updated", "type": args.type, "record_id": args.record_id, "changed_fields": sorted(changes)})
            return 0
        if args.command == "delete-record":
            store = _store(args)
            removed = ControlSession(store).delete_record(args.person, args.type, args.record_id)
            if removed is None:
                raise VaultError("record not found for this person")
            store.save()
            _print({"status": "deleted", "type": args.type, "record_id": args.record_id})
            return 0
        if args.command == "edit-medication":
            if args.clear_dose and args.dose is not None:
                raise VaultError("--dose cannot be combined with --clear-dose")
            if args.clear_unit and args.unit is not None:
                raise VaultError("--unit cannot be combined with --clear-unit")
            if args.clear_note and args.note is not None:
                raise VaultError("--note cannot be combined with --clear-note")
            changes = {}
            for name in ("taken_at", "medication", "dose", "unit", "note", "taken"):
                value = getattr(args, name)
                if value is not None:
                    changes[name] = value
            if args.clear_dose:
                changes["dose"] = None
            if args.clear_unit:
                changes["unit"] = None
            if args.clear_note:
                changes["note"] = None
            store = _store(args)
            updated = store.update_medication(args.person, args.record_id, changes)
            if not updated:
                raise VaultError("medication record not found for this person")
            store.save()
            _print({"status": "updated", "type": "medication", "record_id": args.record_id, "changed_fields": sorted(changes)})
            return 0
        if args.command == "record-activity":
            store = _store(args)
            store.ensure_person(args.person)
            added = store.record_activity(
                args.person, args.date, args.activity_type, args.duration, args.distance, args.steps, note=args.note
            )
            store.save()
            _print({"status": "recorded" if added else "duplicate", "type": "activity", "activity_type": args.activity_type})
            return 0
        if args.command == "record-emotion":
            store = _store(args)
            store.ensure_person(args.person)
            added = store.record_emotion(
                args.person,
                args.occurred_at,
                args.name,
                duration_minutes=args.duration,
                feelings=args.feelings,
                reflection=args.reflection,
            )
            store.save()
            _print({
                "status": "recorded" if added else "duplicate",
                "type": "emotion",
                "name": args.name.strip(),
                "occurred_at": args.occurred_at.strip(),
            })
            return 0
        if args.command == "record-sleep":
            store = _store(args)
            store.ensure_person(args.person)
            added = store.record_sleep(
                args.person,
                args.date,
                duration_minutes=args.duration,
                bedtime=args.bedtime,
                wake_time=args.wake_time,
                quality=args.quality,
                note=args.note,
            )
            store.save()
            _print({
                "status": "recorded" if added else "duplicate",
                "type": "sleep",
                "date": args.date.strip(),
            })
            return 0
        if args.command == "record-encounter":
            store = _store(args)
            store.ensure_person(args.person)
            encounter = store.create_encounter(
                args.person, args.occurred_on, facility=args.facility, department=args.department,
                encounter_type=args.type, note=args.note, document_ids=args.document_ids,
            )
            _print({"status": "recorded", "encounter": store.state["encounters"][encounter.id]})
            return 0
        if args.command == "record-diagnosis-mention":
            store = _store(args)
            store.ensure_person(args.person)
            mention = store.record_diagnosis_mention(
                args.person, args.text, args.context, occurred_on=args.occurred_on,
                encounter_id=args.encounter, document_id=args.document, evidence_id=args.evidence,
            )
            _print({"status": "recorded", "diagnosis_mention": store.state["diagnoses"][mention.id]})
            return 0
        if args.command == "create-medication-plan":
            if args.activate and not args.confirm_plan:
                raise VaultError("--activate requires --confirm-plan")
            store = _store(args)
            store.ensure_person(args.person)
            plan = store.create_medication_plan(
                args.person, args.medication, args.schedule, dose=args.dose, unit=args.unit, route=args.route,
                starts_on=args.starts_on, ends_on=args.ends_on,
                status="active" if args.activate else "draft", user_confirmed=args.confirm_plan,
                source_document_id=args.source_document, source_evidence_id=args.source_evidence,
            )
            _print({"status": "created", "medication_plan": store.state["medication_plans"][plan.id]})
            return 0
        if args.command == "create-reminder":
            store = _store(args)
            store.ensure_person(args.person)
            rule = store.create_reminder_rule(
                args.person, args.kind, args.schedule, args.title, medication_plan_id=args.medication_plan,
                due_on=args.due_on, timezone_name=args.timezone, quiet_start=args.quiet_start, quiet_end=args.quiet_end,
            )
            _print({"status": "created", "reminder": store.state["reminder_rules"][rule.id]})
            return 0
        if args.command == "edit-medication-plan":
            try:
                changes = json.loads(args.changes)
            except ValueError as exc:
                raise VaultError("--changes must be valid JSON") from exc
            updated = _store(args).update_medication_plan(args.person, args.plan, changes)
            if not updated:
                raise VaultError("medication plan not found for this person")
            _print({"status": "updated", "medication_plan_id": args.plan, "changed_fields": sorted(changes)})
            return 0
        if args.command == "encounters":
            _print(_store(args).encounters(args.person))
            return 0
        if args.command == "diagnoses":
            _print(_store(args).diagnoses(args.person))
            return 0
        if args.command == "medication-plans":
            _print(_store(args).medication_plans(args.person))
            return 0
        if args.command == "reminders":
            _print(_store(args).reminder_rules(args.person, include_paused=args.include_paused))
            return 0
        if args.command == "reminders-due":
            _print(_store(args).due_reminder_occurrences(args.person, args.at))
            return 0
        if args.command == "complete-reminder":
            completed = _store(args).complete_reminder_occurrence(args.person, args.occurrence)
            if not completed:
                raise VaultError("reminder occurrence not found for this person")
            _print({"status": "completed", "occurrence_id": args.occurrence})
            return 0
        if args.command == "set-reminder-status":
            updated = _store(args).set_reminder_rule_status(args.person, args.rule, args.status)
            if not updated:
                raise VaultError("reminder rule not found for this person")
            _print({"status": args.status, "reminder_rule_id": args.rule})
            return 0
        if args.command == "trend":
            _print(_store(args).trend_summary(args.person, args.source, args.field, args.start, args.end))
            return 0
        if args.command == "visit-summary":
            summary = _store(args).visit_summary(args.person, args.start, args.end)
            if args.output:
                from .summaries import render_visit_summary_markdown
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(render_visit_summary_markdown(summary), encoding="utf-8")
                args.output.chmod(0o600)
                _print({"status": "draft_exported", "output": str(args.output), "person_id": args.person})
            else:
                _print(summary)
            return 0
        if args.command == "import-csv":
            from .csv_import import CsvImportError, parse_blood_pressure, parse_exercise, parse_medication, parse_weight

            store = _store(args)
            store.ensure_person(args.person, args.display_name)
            idempotency_key = args.idempotency_key or f"csv:{args.type}:{args.file.name}:{args.file.stat().st_size}"
            try:
                if args.type == "blood-pressure":
                    records = parse_blood_pressure(args.file)
                    count = store.import_vitals(args.person, records, idempotency_key)
                elif args.type == "weight":
                    records = parse_weight(args.file)
                    count = store.import_vitals(args.person, records, idempotency_key)
                elif args.type == "medication":
                    records = parse_medication(args.file)
                    count = store.import_medications(args.person, records, idempotency_key)
                else:
                    records = parse_exercise(args.file)
                    count = store.import_activities(args.person, records, idempotency_key)
            except CsvImportError as exc:
                raise VaultError(str(exc)) from exc
            _print({
                "status": "imported" if count else "already_imported",
                "type": args.type,
                "person_id": args.person,
                "records": count,
            })
            return 0
        if args.command == "llm-extract":
            if not args.consent_remote:
                raise VaultError(
                    "llm-extract sends the image (personal health data) to a remote LLM; "
                    "pass --consent-remote to acknowledge this data egress"
                )
            from .llm_extractor import LlmExtractionError, extract_image

            store = _store(args)
            if args.person:
                store.ensure_person(args.person, args.display_name)
            try:
                fields = extract_image(args.image, endpoint=args.endpoint, model=args.model)
            except LlmExtractionError as exc:
                raise VaultError(str(exc)) from exc
            source_bytes = args.image.read_bytes()
            source_sha256 = hashlib.sha256(source_bytes).hexdigest()
            job = store.import_llm_extraction(
                args.image.name,
                fields,
                person_id=args.person,
                report_date=args.report_date,
                idempotency_key=f"llm:{source_sha256}:{args.model or 'default'}",
                source_bytes=source_bytes,
                source_media_type=mimetypes.guess_type(str(args.image))[0] or "image/*",
            )
            candidates = [store.state["candidates"][cid] for cid in job.candidate_ids]
            _print({
                "status": "extracted",
                "job": {"id": job.id, "person_id": job.person_id, "document_id": job.document_id, "status": job.status},
                "fields": [
                    {
                        "field": c["field"],
                        "value": c["text_value"] if c.get("value_type") == "text" else c["normalized_value"],
                        "unit": c["unit"],
                        "mapping_status": c["mapping_status"],
                        "raw_value": c["raw_value"],
                    }
                    for c in candidates
                ],
                "candidates": len(candidates),
            })
            return 0
        if args.command == "re-extract":
            store = _store(args)
            job = store.re_extract_document(args.document)
            candidates = [store.state["candidates"][candidate_id] for candidate_id in job.candidate_ids]
            _print({
                "job": {
                    "id": job.id,
                    "person_id": job.person_id,
                    "document_id": job.document_id,
                    "status": job.status,
                    "candidate_ids": job.candidate_ids,
                },
                "candidates": candidates,
            })
            return 0
        if args.command == "assign-document":
            store = _store(args)
            store.ensure_person(args.person)
            job = ControlSession(store).assign_document(args.document, args.person)
            _print({"document": args.document, "person_id": args.person, "job_id": job.id, "status": job.status})
            return 0
        if args.command == "review-job":
            if args.accept_all and (args.value is not None or args.unit):
                raise VaultError("--accept-all cannot be combined with --value or --unit")
            if not args.accept_all and (args.field is None or args.value is None):
                raise VaultError("use --accept-all or provide --field and --value")
            if not args.accept_all and args.unit and not args.field:
                raise VaultError("--unit requires --field and --value")
            job = ControlSession(_store(args)).review_job(
                args.job, args.accept_all, args.field, args.value, args.unit
            )
            _print({
                "id": job.id,
                "status": job.status,
                "completed_at": job.completed_at,
                "confirmation_receipt_id": job.confirmation_receipt_id,
            })
            return 0
        if args.command == "timeline":
            store = _store(args)
            values = store.observations(args.person, args.field)
            if args.days is not None:
                if args.days < 1 or args.days > 366:
                    raise VaultError("--days must be between 1 and 366")
                cutoff = (datetime.now().date() - timedelta(days=args.days - 1)).isoformat()
                values = [v for v in values if (v.get("measured_at") or "")[:10] >= cutoff]
            _print(values)
            return 0
        if args.command == "recent":
            _print(_store(args).recent(args.person, args.days))
            return 0
        if args.command == "evidence":
            _print(_store(args).evidence_for(args.person, args.observation))
            return 0
        if args.command == "export":
            path = ControlSession(_store(args)).export_confirmed(
                args.person,
                args.output,
                export_passphrase=args.export_passphrase,
                plaintext=args.plaintext,
                confirm_plaintext=args.confirm,
            )
            _print({"status": "exported", "output": str(path), "encrypted": not args.plaintext})
            return 0
        if args.command == "benchmark":
            _print(run_benchmark(args.golden))
            return 0
        if args.command == "decode-file":
            document = decode_file(
                args.file,
                tuple(args.ocr_languages or ("chi_sim", "eng")),
                ocr_engine=args.ocr_engine,
                ocr_command=args.ocr_command,
                sandbox=False if args.no_sandbox else None,
            )
            _print({
                "filename": document.filename,
                "media_type": document.media_type,
                "decoder": document.decoder,
                "pages": [
                    {
                        "page_number": page.page_number,
                        "characters": len(page.text),
                        "text_sha256": page_digest(page),
                        "media_type": page.media_type,
                        "decoder": page.decoder,
                    }
                    for page in document.pages
                ],
            })
            return 0
        if args.command == "issue-session":
            path = _store(args).issue_session(
                args.output,
                args.person,
                args.host_id,
                args.scopes,
                args.ttl_seconds,
                expected_peer_exec_digest=args.expected_exec_digest,
            )
            _print({"status": "issued", "session_file": str(path), "expires_in_seconds": args.ttl_seconds})
            return 0
        if args.command == "pair-agent":
            manager = TrustManager(_store(args), MacOSKeychain())
            profile, _token = manager.pair_agent(
                args.display_name,
                args.host_id,
                args.executable_digest,
                args.person_ids,
                args.scopes,
            )
            _print({
                "status": "paired",
                "agent_id": profile.agent_id,
                "host_id": profile.host_id,
                "person_ids": list(profile.person_ids),
                "scopes": list(profile.scopes),
                "token": "stored in macOS Keychain; not returned",
            })
            return 0
        if args.command == "revoke-agent":
            profile = TrustManager(_store(args), MacOSKeychain()).revoke_agent(args.agent_id)
            _print({"status": "revoked", "agent_id": profile.agent_id, "revoked_at": profile.revoked_at})
            return 0
        if args.command == "list-agents":
            profiles = TrustManager(_store(args), MacOSKeychain()).list_profiles()
            _print([
                {
                    "agent_id": profile.agent_id,
                    "display_name": profile.display_name,
                    "host_id": profile.host_id,
                    "person_ids": list(profile.person_ids),
                    "scopes": list(profile.scopes),
                    "revoked_at": profile.revoked_at,
                }
                for profile in profiles
            ])
            return 0
        if args.command == "backup":
            path = ControlSession(_store(args)).backup_to(args.output, args.backup_passphrase)
            _print({"status": "backed_up", "backup": str(path)})
            return 0
        if args.command == "restore":
            path = VaultStore.restore_from(
                args.backup,
                args.output,
                args.backup_passphrase,
                confirmation=args.confirm,
                replace=args.replace,
            )
            _print({
                "status": "restored",
                "vault": str(path),
                "receipt": str(path.with_name(f"{path.name}.restore-receipt.json")),
            })
            return 0
        if args.command == "rotate-key":
            new_passphrase = args.new_passphrase or getpass.getpass("New Vault passphrase: ")
            ControlSession(_store(args)).rotate_passphrase(new_passphrase)
            _print({"status": "key_rotated"})
            return 0
        if args.command == "crypto-erase":
            tombstone = ControlSession(_store(args)).crypto_erase(args.confirm)
            _print({"status": "erased", "tombstone": str(tombstone)})
            return 0
        if args.command == "daemon":
            store = _store(args)
            manager = TrustManager(store, MacOSKeychain())
            LocalHealthDaemon(args.socket, manager).serve_forever()
            return 0
        if args.command == "workbuddy-configure":
            from .workbuddy_entrypoint import config_path, write_config
            path = args.output or config_path()
            written = write_config(
                path, socket=args.socket, agent_id=args.agent_id, host_id=args.host_id,
                person_id=args.person, replace=args.replace,
            )
            _print({"status": "configured", "config": str(written), "contains_secrets": False})
            return 0
        raise VaultError(f"unknown command: {args.command}")
    except (OSError, VaultError, DecoderError) as exc:
        print(f"healthcare: {exc}", file=sys.stderr)
        return 2
