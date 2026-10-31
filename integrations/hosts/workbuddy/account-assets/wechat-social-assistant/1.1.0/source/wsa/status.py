from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess

from .parser import extract_signals
from .profiles import build_profiles
from .store import connect, init_db
from .suggestions import build_suggestions, followup_strength_label
from .timefmt import format_display_time


@dataclass(frozen=True)
class StatusReport:
    db_path: Path
    db_exists: bool
    contact_count: int
    profile_count: int
    capture_count: int
    signal_count: int
    latest_captured_at: str | None
    latest_contact: str | None
    latest_source: str | None
    latest_image_path: str | None
    captures_dir: Path
    screenshot_count: int
    log_file: Path
    log_exists: bool
    log_line_count: int
    last_log_line: str | None
    watch_processes: tuple[int, ...]
    top_followup: str | None

    @property
    def watch_running(self) -> bool:
        return bool(self.watch_processes)


def build_status_report(
    db_path: Path | str,
    *,
    log_file: Path | str | None = None,
    captures_dir: Path | str | None = None,
    process_rows: list[str] | None = None,
    as_of: str | None = None,
) -> StatusReport:
    db = Path(db_path)
    log = Path(log_file) if log_file is not None else db.parent / "watch.log"
    screenshots = Path(captures_dir) if captures_dir is not None else db.parent / "captures"

    if db.exists():
        # Status is read-only from the user's perspective, but opening an old
        # database must still run the idempotent schema migrations before the
        # effective-text query below.
        init_db(db)

    contact_count = 0
    profile_count = 0
    capture_count = 0
    signal_count = 0
    latest_captured_at = None
    latest_contact = None
    latest_source = None
    latest_image_path = None
    top_followup = None
    if db.exists():
        with connect(db) as conn:
            contact_count = int(conn.execute("select count(*) from people").fetchone()[0])
            capture_count = int(conn.execute("select count(*) from captures").fetchone()[0])
            signal_count = _count_current_signals(conn)
            latest = conn.execute(
                """
                select c.captured_at, p.name, c.source, c.image_path
                from captures c
                join people p on p.id = c.person_id
                order by c.captured_at desc, c.id desc
                limit 1
                """
            ).fetchone()
            if latest:
                latest_captured_at = latest["captured_at"]
                latest_contact = latest["name"]
                latest_source = latest["source"]
                latest_image_path = latest["image_path"]
            profile_count = len(build_profiles(db))
            top_followup = _top_followup_summary(db, as_of=as_of)

    return StatusReport(
        db_path=db,
        db_exists=db.exists(),
        contact_count=contact_count,
        profile_count=profile_count,
        capture_count=capture_count,
        signal_count=signal_count,
        latest_captured_at=latest_captured_at,
        latest_contact=latest_contact,
        latest_source=latest_source,
        latest_image_path=latest_image_path,
        captures_dir=screenshots,
        screenshot_count=_count_screenshots(screenshots),
        log_file=log,
        log_exists=log.exists(),
        log_line_count=_count_log_lines(log),
        last_log_line=_last_log_line(log),
        watch_processes=_detect_watch_processes(
            _process_rows() if process_rows is None else process_rows,
            current_pid=os.getpid(),
            db_path=db,
        ),
        top_followup=top_followup,
    )


def render_status_report(report: StatusReport) -> str:
    quality_notes = status_quality_notes(report)
    lines = [
        "# WeChat Social Assistant Status",
        "",
        f"db: {report.db_path} ({'exists' if report.db_exists else 'missing'})",
        f"contacts: {report.contact_count}",
        f"profiles: {report.profile_count}",
        f"captures: {report.capture_count}",
        f"signals: {report.signal_count}",
        f"screenshots: {report.screenshot_count}",
        f"top followup: {report.top_followup or 'none'}",
        f"watch: {'running (' + str(len(report.watch_processes)) + ' process)' if report.watch_running else 'stopped'}",
        f"quality: {'；'.join(quality_notes) if quality_notes else 'ok'}",
    ]
    if report.latest_captured_at and report.latest_contact:
        source = f" source={report.latest_source}" if report.latest_source else ""
        lines.append(f"latest: {format_display_time(report.latest_captured_at)} {report.latest_contact}{source}")
        if report.latest_image_path:
            lines.append(f"latest image: {report.latest_image_path}")
    else:
        lines.append("latest: none")
    lines.extend(
        [
            f"captures dir: {report.captures_dir}",
            f"log: {report.log_file} ({'exists' if report.log_exists else 'missing'}, {report.log_line_count} lines)",
        ]
    )
    if report.last_log_line:
        lines.append(f"last log: {report.last_log_line}")
    else:
        lines.append("last log: none")
    return "\n".join(lines) + "\n"


def status_quality_notes(report: StatusReport) -> tuple[str, ...]:
    notes: list[str] = []
    if report.capture_count == 0:
        notes.append("暂无采集数据，先运行 capture/watch/ingest")
    elif report.capture_count < 5:
        notes.append(f"采集样本较少（{report.capture_count} 条），画像可能不完整")
    if report.capture_count > 0 and report.signal_count == 0:
        notes.append("暂未识别到关系信号，建议继续采集更多上下文")
    if not report.watch_running:
        notes.append("自动截图未运行，分析只基于现有数据")
    return tuple(notes)


def _count_current_signals(conn) -> int:
    rows = conn.execute(
        "select coalesce(corrected_text, clean_text) as effective_text from captures"
    ).fetchall()
    return sum(len(extract_signals(row["effective_text"])) for row in rows)


def _top_followup_summary(db: Path, *, as_of: str | None = None) -> str | None:
    min_score = 45
    suggestions = build_suggestions(db, as_of=as_of, limit=1, min_score=min_score)
    if not suggestions:
        hidden_suggestions = build_suggestions(db, as_of=as_of, limit=1, min_score=0)
        if not hidden_suggestions:
            return None
        top = hidden_suggestions[0]
        return (
            f"暂无 {min_score} 分以上建议；最高低分建议：{top.person_name} / {top.action} / "
            f"{top.score}分 / {followup_strength_label(top.score)}；查看低分草稿：suggest --min-score 0"
        )
    top = suggestions[0]
    return f"{top.person_name} / {top.action} / {top.score}分 / {followup_strength_label(top.score)}"


def detect_watch_processes(process_rows: list[str], *, current_pid: int | None = None) -> tuple[int, ...]:
    return _detect_watch_processes(process_rows, current_pid=current_pid, db_path=None)


def _detect_watch_processes(
    process_rows: list[str],
    *,
    current_pid: int | None = None,
    db_path: Path | str | None = None,
) -> tuple[int, ...]:
    pids: list[int] = []
    current = current_pid or os.getpid()
    selected_db = _normalize_process_path(db_path) if db_path is not None else None
    for row in process_rows:
        parsed = _parse_process_row(row)
        if not parsed:
            continue
        pid, command = parsed
        if pid == current:
            continue
        if _is_watch_command(command):
            command_db = _watch_command_db_path(command)
            if selected_db is not None and command_db is not None and command_db != selected_db:
                continue
            pids.append(pid)
    return tuple(pids)


def stop_watch_processes(
    *,
    process_rows: list[str] | None = None,
    current_pid: int | None = None,
    db_path: Path | str | None = None,
    dry_run: bool = False,
    kill_fn=os.kill,
    sig: int = signal.SIGTERM,
) -> tuple[int, ...]:
    pids = _detect_watch_processes(
        _process_rows() if process_rows is None else process_rows,
        current_pid=current_pid or os.getpid(),
        db_path=db_path,
    )
    if dry_run:
        return pids
    for pid in pids:
        kill_fn(pid, sig)
    return pids


def _count_screenshots(path: Path) -> int:
    if not path.exists():
        return 0
    suffixes = {".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff"}
    return sum(1 for item in path.iterdir() if item.is_file() and item.suffix.lower() in suffixes)


def _process_rows() -> list[str]:
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return []
    if result.returncode != 0:
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


def _parse_process_row(row: str) -> tuple[int, str] | None:
    match = re.match(r"^\s*(\d+)\s+(.+?)\s*$", row)
    if not match:
        return None
    return int(match.group(1)), match.group(2)


def _is_watch_command(command: str) -> bool:
    if re.search(r"\b(rg|grep|pgrep)\b", command):
        return False
    return _watch_command_args(command) is not None


def _watch_command_args(command: str) -> list[str] | None:
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    for index, token in enumerate(tokens):
        if token == "-m" and index + 1 < len(tokens) and tokens[index + 1] == "wsa.cli":
            args = tokens[index + 2 :]
            return args if "watch" in args else None
        if Path(token).name == "wsa":
            args = tokens[index + 1 :]
            return args if "watch" in args else None
    return None


def _watch_command_db_path(command: str) -> Path | None:
    args = _watch_command_args(command)
    if not args:
        return None
    for index, token in enumerate(args):
        if token == "--db" and index + 1 < len(args):
            return _normalize_process_path(args[index + 1])
        if token.startswith("--db="):
            return _normalize_process_path(token.split("=", 1)[1])
    return None


def _normalize_process_path(path: Path | str | None) -> Path | None:
    if path is None:
        return None
    return Path(path).expanduser().resolve(strict=False)


def _count_log_lines(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for _ in handle)


def _last_log_line(path: Path) -> str | None:
    if not path.exists():
        return None
    last = None
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            cleaned = line.strip()
            if cleaned:
                last = cleaned
    return last
