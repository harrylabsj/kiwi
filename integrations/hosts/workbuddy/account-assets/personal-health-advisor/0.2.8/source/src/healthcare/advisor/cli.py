"""`health-advisor` — the Skill command line for 个人健康管理顾问.

stdout is always one JSON document; errors are JSON on stderr with a coded
exit status. The passphrase never appears in argv or output. Candidate
confirmation is field-by-field only (`confirm --field --value [--unit]`),
there is no accept-all.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

from ..control import ControlSession
from ..decoder import DecoderError, decode_file
from ..summaries import render_visit_summary_markdown
from ..vault import VaultConflictError, VaultError, VaultStore
from . import VERSION
from .auth import (
    AuthError, DEMO_PASSPHRASE, open_vault, passphrase_source, read_passphrase_file, resolve_passphrase,
    revoke_passphrase, store_passphrase,
)
from .demo import DEMO_PERSON, ensure_demo_vault
from .paths import data_dir, ensure_data_dir, live_vault_path, passphrase_path
from .settings import SettingsError, load_settings, parse_bp_target, save_settings, validate_goals
from .workbench import ALLOWED_DAYS, WorkbenchError, write_workbench

EXIT_OK, EXIT_ERROR, EXIT_ARGS, EXIT_AUTH, EXIT_NOT_FOUND, EXIT_CONFIRM, EXIT_RUNTIME = 0, 1, 2, 3, 4, 5, 6
MIN_PYTHON = (3, 11)


class UsageError(ValueError):
    """Argument or validation problem (exit code 2)."""


class NotFoundError(ValueError):
    """A record, job or document does not exist for this person (exit code 4)."""


class ConfirmationError(ValueError):
    """An explicit confirmation flag is required (exit code 5)."""


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # type: ignore[override]
        raise UsageError(message)


def _print(value: Any) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _fail(code: int, error: str, message: str) -> int:
    sys.stderr.write(json.dumps({"error": error, "message": message, "exit_code": code}, ensure_ascii=False) + "\n")
    return code


def _read_json_file(path: Path, label: str) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UsageError(f"{label} 必须是可读取的 JSON 文件") from exc
    if not isinstance(raw, dict):
        raise UsageError(f"{label} 的顶层必须是 JSON 对象")
    return raw


def _text_or_file(value: str | None, file: Path | None, label: str) -> str | None:
    if value is not None and file is not None:
        raise UsageError(f"{label} 与 {label}-file 不能同时提供")
    if file is not None:
        try:
            return file.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise UsageError(f"无法读取 {label}-file") from exc
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="health-advisor", description="个人健康管理顾问 · 本地 Skill 命令（stdout 始终为 JSON）", add_help=True)
    parser.add_argument("--mode", choices=("live", "demo"), default="live", help="live=个人档案（默认）；demo=独立虚构示例")
    parser.add_argument("--person", help="覆盖设置中的默认人物 ID")
    parser.add_argument("--version", action="version", version=f"health-advisor {VERSION}")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="运行环境、档案、人物与口令来源（不含口令）")

    auth = sub.add_parser("auth", help="本机口令：init <文件> | import <文件> | status | revoke")
    auth_sub = auth.add_subparsers(dest="auth_command", required=True)
    auth_init = auth_sub.add_parser("init", help="用口令文件创建新的加密档案并保存口令")
    auth_init.add_argument("file", type=Path)
    auth_init.add_argument("--person", dest="init_person", help="新档案的默认人物 ID（默认 me）")
    auth_init.add_argument("--display-name")
    auth_import = auth_sub.add_parser("import", help="为已有档案导入口令文件")
    auth_import.add_argument("file", type=Path)
    auth_import.add_argument("--vault", type=Path, help="已有档案路径（记录到设置中）")
    auth_sub.add_parser("status", help="口令来源与档案状态")
    auth_sub.add_parser("revoke", help="删除本机保存的口令副本")

    settings = sub.add_parser("settings", help="查看或修改默认人物、医嘱血压区间、目标")
    settings_sub = settings.add_subparsers(dest="settings_command")
    settings_set = settings_sub.add_parser("set")
    settings_set.add_argument("--person", dest="set_person")
    settings_set.add_argument("--display-name")
    settings_set.add_argument("--timezone")
    settings_set.add_argument("--vault", type=Path)
    settings_set.add_argument("--bp-target", help="例如 90-130/60-90")
    settings_set.add_argument("--goals-file", type=Path, help="JSON 文件：{\"goals\": [...]}")

    record = sub.add_parser("record", help="记录用户明确陈述的实际事件")
    record_sub = record.add_subparsers(dest="record_type", required=True)
    vital = record_sub.add_parser("vital")
    vital.add_argument("--at", help="测量时间 YYYY-MM-DDTHH:MM")
    vital.add_argument("--systolic", type=int)
    vital.add_argument("--diastolic", type=int)
    vital.add_argument("--heart-rate", type=int)
    vital.add_argument("--weight", type=float)
    vital.add_argument("--note")
    vital.add_argument("--input", type=Path, help="JSON 文件，字段同选项名（下划线）")
    medication = record_sub.add_parser("medication")
    medication.add_argument("--at", help="服药时间 YYYY-MM-DDTHH:MM")
    medication.add_argument("--medication")
    medication.add_argument("--dose")
    medication.add_argument("--unit")
    medication.add_argument("--missed", action="store_true", help="记录为明确未服")
    medication.add_argument("--note")
    medication.add_argument("--plan", help="已确认的用药计划 ID")
    medication.add_argument("--input", type=Path)
    activity = record_sub.add_parser("activity")
    activity.add_argument("--date")
    activity.add_argument("--type", dest="activity_type")
    activity.add_argument("--duration", type=float, help="分钟")
    activity.add_argument("--distance", type=float, help="公里")
    activity.add_argument("--steps", type=int)
    activity.add_argument("--note", help="计数型运动写在这里，例如“共 60 个”")
    activity.add_argument("--input", type=Path)
    emotion = record_sub.add_parser("emotion")
    emotion.add_argument("--at")
    emotion.add_argument("--name")
    emotion.add_argument("--duration", type=float)
    emotion.add_argument("--feelings")
    emotion.add_argument("--feelings-file", type=Path)
    emotion.add_argument("--reflection")
    emotion.add_argument("--reflection-file", type=Path)
    emotion.add_argument("--input", type=Path)
    sleep = record_sub.add_parser("sleep")
    sleep.add_argument("--date", help="起床日 YYYY-MM-DD")
    sleep.add_argument("--duration", type=float, help="分钟")
    sleep.add_argument("--bedtime")
    sleep.add_argument("--wake-time")
    sleep.add_argument("--quality", type=int)
    sleep.add_argument("--note")
    sleep.add_argument("--input", type=Path)

    edit = sub.add_parser("edit", help="按 ID 原地修改一条记录（保留审计）")
    edit.add_argument("--type", required=True, choices=("vital", "medication", "activity", "emotion", "sleep"))
    edit.add_argument("--id", required=True, dest="record_id")
    edit.add_argument("--changes", help="JSON 对象；null 清空可选字段")
    edit.add_argument("--changes-file", type=Path)

    recent = sub.add_parser("recent", help="近 N 天的日常记录（写后核验）")
    recent.add_argument("--days", type=int, default=7)

    trend = sub.add_parser("trend", help="确定性趋势统计")
    trend.add_argument("--source", required=True, choices=("vital", "observation"))
    trend.add_argument("--field", required=True)
    trend.add_argument("--start")
    trend.add_argument("--end")

    labs = sub.add_parser("labs", help="已确认的检验时间线")
    labs.add_argument("--field")
    labs.add_argument("--days", type=int)

    evidence = sub.add_parser("evidence", help="某条已确认观察的原始证据")
    evidence.add_argument("observation_id")

    imp = sub.add_parser("import", help="导入报告到待核对区（文本 / PDF / 图片）")
    imp.add_argument("file", type=Path)
    imp.add_argument("--report-date", help="报告日期 YYYY-MM-DD；不确定时留空，将不进入趋势")
    imp.add_argument("--display-name")
    imp.add_argument("--ocr-engine", choices=("vision", "tesseract"), default="tesseract" if sys.platform == "win32" else "vision")

    candidates = sub.add_parser("candidates", help="列出一份导入的待核对字段")
    candidates.add_argument("job_id")

    confirm = sub.add_parser("confirm", help="用户逐字段确认后写入正式记录（无 accept-all）")
    confirm.add_argument("job_id")
    confirm.add_argument("--field", required=True)
    confirm.add_argument("--value", required=True, type=float)
    confirm.add_argument("--unit", help="与档案规范单位不同时，给出换算后的值和规范单位")

    assign = sub.add_parser("assign", help="确认待核对文档属于当前人物")
    assign.add_argument("document_id")

    sub.add_parser("encounters", help="就诊记录与诊断原文")
    sub.add_parser("plans", help="用药计划（与实际服药事件分开）")
    sub.add_parser("reminders", help="提醒规则（提醒完成不代表实际服药）")

    summary = sub.add_parser("visit-summary", help="就医资料摘要草稿")
    summary.add_argument("--start")
    summary.add_argument("--end")
    summary.add_argument("--output", type=Path, help="写入 Markdown 文件（0600）")

    workbench = sub.add_parser("workbench", help="生成个人健康管理工作台（只读 HTML）")
    workbench.add_argument("output", type=Path)
    workbench.add_argument("--days", type=int, default=14, choices=ALLOWED_DAYS)

    sub.add_parser("mcp", help="以 stdio MCP 服务运行（WorkBuddy 内嵌工作台与工具；由专家的 .mcp.json 启动）")

    backup = sub.add_parser("backup", help="备份：export <路径> | import <备份> --confirm RESTORE_VAULT")
    backup_sub = backup.add_subparsers(dest="backup_command", required=True)
    backup_export = backup_sub.add_parser("export")
    backup_export.add_argument("path", type=Path)
    backup_export.add_argument("--passphrase-file", required=True, type=Path, help="独立的备份口令文件（一行）")
    backup_import = backup_sub.add_parser("import")
    backup_import.add_argument("path", type=Path)
    backup_import.add_argument("--passphrase-file", required=True, type=Path)
    backup_import.add_argument("--confirm", help="必须为 RESTORE_VAULT")
    backup_import.add_argument("--replace", action="store_true", help="覆盖现有档案")
    return parser


class Context:
    """Resolved mode, vault path, person and settings for one invocation."""

    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.mode = args.mode
        self.settings = load_settings()
        if self.mode == "demo":
            self.vault_path = ensure_demo_vault(date.today())
            self.person_id = args.person or DEMO_PERSON
        else:
            self.vault_path = live_vault_path(self.settings.get("vault"))
            self.person_id = args.person or self.settings.get("person_id") or "me"

    def open(self) -> VaultStore:
        passphrase = resolve_passphrase(self.mode)
        store = open_vault(self.vault_path, passphrase)
        return store

    def open_for_person(self) -> VaultStore:
        store = self.open()
        if self.person_id not in store.state["persons"]:
            if self.mode == "demo":
                raise NotFoundError(f"示例档案中没有人物 {self.person_id}")
            store.ensure_person(self.person_id, self.settings.get("display_name"))
            store.save()
        return store

    @property
    def vault_label(self) -> str:
        return self.vault_path.name


def _merge_input(args: argparse.Namespace, fields: dict[str, str]) -> dict[str, Any]:
    """Command-line flags win; an --input JSON file supplies the rest."""
    values: dict[str, Any] = {}
    if getattr(args, "input", None) is not None:
        raw = _read_json_file(args.input, "--input")
        unknown = sorted(set(raw) - set(fields))
        if unknown:
            raise UsageError(f"--input 含未知字段：{', '.join(unknown)}")
        values.update(raw)
    for key, attr in fields.items():
        flag = getattr(args, attr, None)
        if flag is not None and flag is not False:
            values[key] = flag
    return values


def _require(values: dict[str, Any], *keys: str) -> None:
    missing = [key for key in keys if values.get(key) in (None, "")]
    if missing:
        raise UsageError(f"缺少必填项：{', '.join('--' + key.replace('_', '-') for key in missing)}")


def _job_summary(store: VaultStore, job: Any) -> dict[str, Any]:
    raw = job if isinstance(job, dict) else store.state["jobs"][job.id]
    candidates = [store.state["candidates"][cid] for cid in raw["candidate_ids"] if cid in store.state["candidates"]]
    document = store.state["documents"].get(raw["document_id"], {})
    return {
        "job_id": raw["id"], "status": raw["status"], "person_id": raw.get("person_id"), "document_id": raw["document_id"],
        "report_date": document.get("report_date"), "filename": document.get("filename"),
        "candidates": [
            {
                "field": item["field"], "raw_value": item["raw_value"],
                "value": item.get("text_value") if item.get("value_type") == "text" else item.get("normalized_value"),
                "unit": item.get("unit"), "raw_unit": item.get("raw_unit"), "mapping_status": item.get("mapping_status"),
                "status": item.get("status"), "evidence_id": item.get("evidence_id"),
                "needs_unit_conversion": item.get("mapping_status") != "mapped",
            }
            for item in candidates
        ],
        "next_step": "逐字段核对后用 confirm <job_id> --field <字段> --value <值> [--unit <规范单位>] 写入；未确认的字段不是健康事实。",
    }


def run(args: argparse.Namespace) -> int:
    command = args.command
    if command == "status":
        return cmd_status(args)
    if command == "auth":
        return cmd_auth(args)
    if command == "settings":
        return cmd_settings(args)
    if command == "mcp":
        try:
            from .mcp_app import main as mcp_main
        except ImportError as exc:  # the `mcp` extra is not installed
            return _fail(EXIT_RUNTIME, "runtime", f"缺少 MCP 运行时依赖（pip install 'healthcare[advisor]'）：{exc.name}")
        return mcp_main()
    ctx = Context(args)
    if command == "record":
        return cmd_record(ctx)
    if command == "edit":
        return cmd_edit(ctx)
    if command == "recent":
        days = ctx.args.days
        if not 1 <= days <= 366:
            raise UsageError("--days 必须在 1 到 366 之间")
        store = ctx.open_for_person()
        payload = store.recent(ctx.person_id, days)
        payload.update({"person_id": ctx.person_id, "mode": ctx.mode})
        _print(payload)
        return EXIT_OK
    if command == "trend":
        store = ctx.open_for_person()
        try:
            _print(store.trend_summary(ctx.person_id, args.source, args.field, args.start, args.end))
        except ValueError as exc:
            raise UsageError(str(exc)) from exc
        return EXIT_OK
    if command == "labs":
        store = ctx.open_for_person()
        values = store.observations(ctx.person_id, args.field)
        if args.days is not None:
            if not 1 <= args.days <= 3660:
                raise UsageError("--days 必须在 1 到 3660 之间")
            cutoff = date.fromordinal(date.today().toordinal() - args.days + 1).isoformat()
            values = [item for item in values if (item.get("measured_at") or "")[:10] >= cutoff]
        _print({"person_id": ctx.person_id, "observations": values, "note": "只包含用户已逐字段确认的观察；待核对候选见 candidates。"})
        return EXIT_OK
    if command == "evidence":
        store = ctx.open_for_person()
        try:
            _print(store.evidence_for(ctx.person_id, args.observation_id))
        except VaultError as exc:
            raise NotFoundError(str(exc)) from exc
        return EXIT_OK
    if command == "import":
        return cmd_import(ctx)
    if command == "candidates":
        store = ctx.open_for_person()
        job = store.state["jobs"].get(args.job_id)
        if not job or job.get("person_id") not in (ctx.person_id, None):
            raise NotFoundError("没有这份导入任务")
        _print(_job_summary(store, job))
        return EXIT_OK
    if command == "confirm":
        store = ctx.open_for_person()
        job = store.state["jobs"].get(args.job_id)
        if not job or job.get("person_id") not in (ctx.person_id, None):
            raise NotFoundError("没有这份导入任务")
        if job.get("person_id") is None:
            raise ConfirmationError("这份文档尚未确认属于谁：先执行 assign <document_id>")
        result = ControlSession(store).review_job(args.job_id, False, args.field, args.value, args.unit)
        _print({
            "status": "confirmed", "job_id": result.id, "job_status": result.status, "field": args.field,
            "value": args.value, "unit": args.unit, "confirmation_receipt_id": result.confirmation_receipt_id,
        })
        return EXIT_OK
    if command == "assign":
        store = ctx.open_for_person()
        if args.document_id not in store.state["documents"]:
            raise NotFoundError("没有这份文档")
        job = ControlSession(store).assign_document(args.document_id, ctx.person_id)
        _print({"status": "assigned", "document_id": args.document_id, "person_id": ctx.person_id, "job_id": job.id, "job_status": job.status})
        return EXIT_OK
    if command == "encounters":
        store = ctx.open_for_person()
        _print({"person_id": ctx.person_id, "encounters": store.encounters(ctx.person_id), "diagnosis_mentions": store.diagnoses(ctx.person_id)})
        return EXIT_OK
    if command == "plans":
        store = ctx.open_for_person()
        _print({"person_id": ctx.person_id, "medication_plans": store.medication_plans(ctx.person_id), "note": "计划与提醒不等于实际服药；实际服药看 recent。"})
        return EXIT_OK
    if command == "reminders":
        store = ctx.open_for_person()
        _print({"person_id": ctx.person_id, "reminders": store.reminder_rules(ctx.person_id, include_paused=True)})
        return EXIT_OK
    if command == "visit-summary":
        store = ctx.open_for_person()
        summary = store.visit_summary(ctx.person_id, args.start, args.end)
        if args.output:
            if args.output.suffix.lower() not in (".md", ".markdown", ".txt"):
                raise UsageError("--output 必须是 .md 或 .txt 文件")
            from .paths import write_private_text

            write_private_text(args.output, render_visit_summary_markdown(summary))
            _print({"status": "draft_exported", "output": str(args.output), "person_id": ctx.person_id, "note": "草稿仅供用户核对，不构成诊断或治疗建议。"})
        else:
            _print(summary)
        return EXIT_OK
    if command == "workbench":
        store = ctx.open_for_person()
        result = write_workbench(
            store, ctx.person_id, args.output, settings=ctx.settings, mode=ctx.mode, days=args.days, vault_label=ctx.vault_label,
        )
        _print(result)
        return EXIT_OK
    if command == "backup":
        return cmd_backup(ctx)
    raise UsageError(f"未知命令：{command}")


def _mcp_available() -> bool:
    try:
        import mcp  # noqa: F401
    except ImportError:
        return False
    return True


def cmd_status(args: argparse.Namespace) -> int:
    settings = load_settings()
    live_path = live_vault_path(settings.get("vault"))
    payload: dict[str, Any] = {
        "version": VERSION,
        "python": ".".join(str(part) for part in sys.version_info[:3]),
        "python_ok": sys.version_info >= MIN_PYTHON,
        "data_dir": str(data_dir()),
        "mode": args.mode,
        "person_id": settings.get("person_id") or "me",
        "vault": str(live_path),
        "vault_exists": live_path.exists(),
        "passphrase_source": passphrase_source(),
        "demo_available": True,
        "mcp_available": _mcp_available(),
        "bp_target": settings["bp_target"],
        "goals": len(settings["goals"]),
    }
    if args.mode == "demo":
        payload["vault"] = str(ensure_demo_vault(date.today()))
        payload["person_id"] = DEMO_PERSON
        payload["vault_exists"] = True
    elif live_path.exists() and passphrase_source() != "none":
        try:
            store = open_vault(live_path, resolve_passphrase("live"))
            person = args.person or payload["person_id"]
            recent = store.recent(person, 7) if person in store.state["persons"] else None
            payload["persons"] = sorted(store.state["persons"])
            payload["recent_7_days"] = {key: len(value) for key, value in recent.items() if isinstance(value, list)} if recent else None
            payload["auth"] = "ok"
        except AuthError as exc:
            payload["auth"] = "failed"
            payload["auth_message"] = str(exc)
    else:
        payload["auth"] = "not_configured"
        payload["next_step"] = "把口令保存为本机文件后执行 auth init <文件>（新档案）或 auth import <文件>（已有档案）"
    _print(payload)
    return EXIT_OK


def cmd_auth(args: argparse.Namespace) -> int:
    settings = load_settings()
    if args.auth_command == "status":
        path = live_vault_path(settings.get("vault"))
        _print({
            "configured": passphrase_source() != "none", "source": passphrase_source(),
            "vault": str(path), "vault_exists": path.exists(), "passphrase_file": str(passphrase_path()),
            "note": "口令本身永不显示；auth 输出可以安全分享。",
        })
        return EXIT_OK
    if args.auth_command == "revoke":
        removed = revoke_passphrase()
        _print({"status": "revoked" if removed else "nothing_to_revoke", "source_now": passphrase_source()})
        return EXIT_OK
    ensure_data_dir()
    passphrase = read_passphrase_file(args.file)
    if args.auth_command == "init":
        path = live_vault_path(settings.get("vault"))
        if path.exists():
            raise ConfirmationError(f"档案已存在：{path}；已有档案请用 auth import")
        person = args.init_person or settings.get("person_id") or "me"
        store = VaultStore.create(path, passphrase)
        store.ensure_person(person, args.display_name)
        store.save()
        store_passphrase(passphrase)
        settings["person_id"] = person
        if args.display_name:
            settings["display_name"] = args.display_name
        save_settings(settings)
        _print({"status": "created", "vault": str(path), "person_id": person, "passphrase_source": passphrase_source(), "next_step": "删除原始口令文件；之后直接使用 record / recent / workbench。"})
        return EXIT_OK
    # import
    path = args.vault.expanduser() if args.vault else live_vault_path(settings.get("vault"))
    open_vault(path, passphrase)
    store_passphrase(passphrase)
    if args.vault:
        settings["vault"] = str(path)
        save_settings(settings)
    _print({"status": "imported", "vault": str(path), "passphrase_source": passphrase_source(), "next_step": "删除原始口令文件；口令副本以 0600 保存在数据目录。"})
    return EXIT_OK


def cmd_settings(args: argparse.Namespace) -> int:
    settings = load_settings()
    if args.settings_command != "set":
        _print(settings)
        return EXIT_OK
    changed = []
    if args.set_person:
        settings["person_id"] = args.set_person.strip()
        changed.append("person_id")
    if args.display_name:
        settings["display_name"] = args.display_name.strip()
        changed.append("display_name")
    if args.timezone:
        settings["timezone"] = args.timezone.strip()
        changed.append("timezone")
    if args.vault:
        settings["vault"] = str(args.vault.expanduser())
        changed.append("vault")
    if args.bp_target:
        settings["bp_target"] = parse_bp_target(args.bp_target)
        changed.append("bp_target")
    if args.goals_file:
        raw = _read_json_file(args.goals_file, "--goals-file")
        settings["goals"] = validate_goals(raw.get("goals"))
        changed.append("goals")
    if not changed:
        raise UsageError("settings set 需要至少一个要修改的选项")
    save_settings(settings)
    _print({"status": "updated", "changed": changed, "settings": load_settings()})
    return EXIT_OK


def cmd_record(ctx: Context) -> int:
    args = ctx.args
    store = ctx.open_for_person()
    person = ctx.person_id
    kind = args.record_type
    if kind == "vital":
        values = _merge_input(args, {"at": "at", "systolic": "systolic", "diastolic": "diastolic", "heart_rate": "heart_rate", "weight": "weight", "note": "note"})
        _require(values, "at")
        if values.get("systolic") is None and values.get("weight") is None:
            raise UsageError("至少提供血压（--systolic 与 --diastolic）或体重（--weight）")
        if (values.get("systolic") is None) != (values.get("diastolic") is None):
            raise UsageError("收缩压与舒张压需要一起提供")
        added = store.record_vital(person, str(values["at"]), values.get("systolic"), values.get("diastolic"), values.get("heart_rate"), weight_kg=values.get("weight"), note=values.get("note"))
        result = {"type": "vital", "measured_at": values["at"]}
    elif kind == "medication":
        values = _merge_input(args, {"at": "at", "medication": "medication", "dose": "dose", "unit": "unit", "missed": "missed", "note": "note", "plan": "plan"})
        _require(values, "at", "medication")
        added = store.record_medication(person, str(values["at"]), str(values["medication"]), values.get("dose"), values.get("unit"), taken=not values.get("missed"), note=values.get("note"), medication_plan_id=values.get("plan"))
        result = {"type": "medication", "medication": values["medication"], "taken": not values.get("missed")}
    elif kind == "activity":
        values = _merge_input(args, {"date": "date", "type": "activity_type", "duration": "duration", "distance": "distance", "steps": "steps", "note": "note"})
        _require(values, "date", "type")
        added = store.record_activity(person, str(values["date"]), str(values["type"]), values.get("duration"), values.get("distance"), values.get("steps"), note=values.get("note"))
        result = {"type": "activity", "activity_type": values["type"], "date": values["date"]}
    elif kind == "emotion":
        values = _merge_input(args, {"at": "at", "name": "name", "duration": "duration", "feelings": "feelings", "reflection": "reflection"})
        values["feelings"] = _text_or_file(values.get("feelings"), args.feelings_file, "--feelings")
        values["reflection"] = _text_or_file(values.get("reflection"), args.reflection_file, "--reflection")
        _require(values, "at", "name")
        added = store.record_emotion(person, str(values["at"]), str(values["name"]), duration_minutes=values.get("duration"), feelings=values.get("feelings"), reflection=values.get("reflection"))
        result = {"type": "emotion", "name": values["name"], "occurred_at": values["at"]}
    else:
        values = _merge_input(args, {"date": "date", "duration": "duration", "bedtime": "bedtime", "wake_time": "wake_time", "quality": "quality", "note": "note"})
        _require(values, "date")
        added = store.record_sleep(person, str(values["date"]), duration_minutes=values.get("duration"), bedtime=values.get("bedtime"), wake_time=values.get("wake_time"), quality=values.get("quality"), note=values.get("note"))
        result = {"type": "sleep", "date": values["date"]}
    store.save()
    result.update({"status": "recorded" if added else "duplicate", "person_id": person, "mode": ctx.mode, "verify": "recent --days 1"})
    _print(result)
    return EXIT_OK


def cmd_edit(ctx: Context) -> int:
    args = ctx.args
    if bool(args.changes) == bool(args.changes_file):
        raise UsageError("提供 --changes 或 --changes-file 之一")
    if args.changes_file:
        changes = _read_json_file(args.changes_file, "--changes-file")
    else:
        try:
            changes = json.loads(args.changes)
        except json.JSONDecodeError as exc:
            raise UsageError("--changes 必须是 JSON 对象") from exc
        if not isinstance(changes, dict):
            raise UsageError("--changes 必须是 JSON 对象")
    if not changes:
        raise UsageError("没有要修改的字段")
    store = ctx.open_for_person()
    if not ControlSession(store).update_record(ctx.person_id, args.type, args.record_id, changes):
        raise NotFoundError("该人物下没有这条记录")
    store.save()
    _print({"status": "updated", "type": args.type, "record_id": args.record_id, "changed_fields": sorted(changes), "verify": "recent --days 30"})
    return EXIT_OK


def cmd_import(ctx: Context) -> int:
    args = ctx.args
    path: Path = args.file.expanduser()
    if not path.is_file() or path.is_symlink():
        raise UsageError("要导入的文件必须是普通文件")
    store = ctx.open_for_person()
    if args.display_name:
        store.ensure_person(ctx.person_id, args.display_name)
    try:
        document = decode_file(path, ocr_engine=args.ocr_engine)
    except DecoderError as exc:
        raise UsageError(f"无法解码文件：{exc}") from exc
    job = store.import_decoded_document(ctx.person_id, document, report_date=args.report_date, source_bytes=path.read_bytes())
    payload = _job_summary(store, job)
    payload["status_note"] = "已进入待核对区；以下字段全部是候选，用户逐字段确认前不是健康事实。"
    _print(payload)
    return EXIT_OK


def cmd_backup(ctx: Context) -> int:
    args = ctx.args
    if ctx.mode == "demo":
        raise UsageError("示例档案不需要备份")
    backup_passphrase = read_passphrase_file(args.passphrase_file)
    if args.backup_command == "export":
        store = ctx.open()
        output = ControlSession(store).backup_to(args.path.expanduser(), backup_passphrase)
        _print({"status": "backed_up", "backup": str(output), "contains_passphrase": False})
        return EXIT_OK
    if args.confirm != "RESTORE_VAULT":
        raise ConfirmationError("导入备份会替换本机档案：请加 --confirm RESTORE_VAULT")
    restored = VaultStore.restore_from(args.path.expanduser(), ctx.vault_path, backup_passphrase, confirmation=args.confirm, replace=args.replace)
    _print({"status": "restored", "vault": str(restored), "next_step": "如备份使用了不同的档案口令，请重新 auth import"})
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < MIN_PYTHON:
        return _fail(EXIT_RUNTIME, "runtime", f"需要 Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} 或更新版本，当前 {sys.version.split()[0]}")
    try:
        args = build_parser().parse_args(argv)
    except UsageError as exc:
        return _fail(EXIT_ARGS, "usage", str(exc))
    try:
        return run(args)
    except UsageError as exc:
        return _fail(EXIT_ARGS, "usage", str(exc))
    except (SettingsError, WorkbenchError) as exc:
        return _fail(EXIT_ARGS, "validation", str(exc))
    except AuthError as exc:
        return _fail(EXIT_AUTH, "auth", str(exc))
    except NotFoundError as exc:
        return _fail(EXIT_NOT_FOUND, "not_found", str(exc))
    except ConfirmationError as exc:
        return _fail(EXIT_CONFIRM, "confirmation_required", str(exc))
    except VaultConflictError as exc:
        return _fail(EXIT_ERROR, "conflict", str(exc))
    except (VaultError, DecoderError, OSError) as exc:
        return _fail(EXIT_ERROR, "error", str(exc))
