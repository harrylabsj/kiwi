from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
from typing import Any

from .store import connect, init_db, now_iso


ARCHIVE_SOURCE_TYPE = "wechat_archive"

SENSITIVE_KEYWORDS = (
    "简历",
    "合同",
    "协议",
    "发票",
    "报销",
    "工资",
    "薪酬",
    "股权",
    "签字",
    "录用通知",
    "身份证",
    "护照",
    "行程单",
)

RELATIONSHIP_KEYWORDS = (
    "名片",
    "名单",
    "拜访",
    "会议",
    "合作",
    "项目",
    "方案",
    "计划",
    "路演",
    "运营",
    "跟踪",
    "汇报",
    "介绍",
    "联系人",
)

TOPIC_BUCKETS = (
    ("新能源", "项目线索：新能源物流"),
    ("物流", "项目线索：新能源物流"),
    ("接待方案", "项目线索：接待方案"),
    ("畜牧", "项目线索：农牧食品"),
    ("饲料", "项目线索：农牧食品"),
    ("邮政", "项目线索：物流网络"),
    ("创投", "项目线索：资本机构"),
    ("资本", "项目线索：资本机构"),
    ("医疗", "项目线索：医疗健康"),
    ("医院", "项目线索：医疗健康"),
    ("健康", "项目线索：医疗健康"),
    ("AI", "项目线索：AI Agent"),
    ("Agent", "项目线索：AI Agent"),
    ("名片", "微信归档：名片线索"),
    ("名单", "微信归档：名单线索"),
)

GENERIC_CONTACT_NAMES = {
    "时间",
    "来源",
    "项目",
    "方案",
    "合作",
    "会议",
    "报告",
    "计划",
}


@dataclass(frozen=True)
class WeChatArchiveImportResult:
    scanned_count: int
    parsed_count: int
    imported_count: int
    duplicate_count: int
    skipped_sensitive_count: int
    skipped_low_score_count: int
    skipped_unmatched_count: int
    by_bucket: dict[str, int]
    by_sensitivity: dict[str, int]
    dry_run: bool = False


@dataclass(frozen=True)
class WeChatArchiveRecord:
    person_name: str
    title: str
    occurred_at: str | None
    summary: str
    fields: dict[str, str]
    raw_text: str
    file_path: str | None
    text_hash: str
    imported_at: str
    score: int
    sensitivity: str


def default_wechat_archive_manifest() -> Path:
    return (
        Path.home()
        / "Library"
        / "Mobile Documents"
        / "com~apple~CloudDocs"
        / "微信归档"
        / "聊天文件-全量-2026-05-11"
        / "manifest-all.tsv"
    )


def import_wechat_archive_manifest(
    db_path: Path | str,
    *,
    manifest_path: Path | str,
    known_contacts: list[str] | tuple[str, ...] = (),
    dry_run: bool = False,
    imported_at: str | None = None,
    limit: int = 300,
    min_score: int = 35,
    include_unmatched: bool = True,
    include_sensitive: bool = False,
) -> WeChatArchiveImportResult:
    init_db(db_path)
    manifest = Path(manifest_path).expanduser()
    timestamp = imported_at or now_iso()
    records: list[WeChatArchiveRecord] = []
    scanned = 0
    skipped_sensitive = 0
    skipped_low_score = 0
    skipped_unmatched = 0
    for row in _read_manifest_rows(manifest):
        scanned += 1
        candidate = _record_from_row(
            row,
            known_contacts=known_contacts,
            imported_at=timestamp,
            include_unmatched=include_unmatched,
        )
        if candidate is None:
            skipped_unmatched += 1
            continue
        if candidate.sensitivity == "high" and not include_sensitive:
            skipped_sensitive += 1
            continue
        if candidate.score < min_score:
            skipped_low_score += 1
            continue
        records.append(candidate)
    records.sort(key=lambda item: (-item.score, item.occurred_at or "", item.title))
    if limit > 0:
        records = records[:limit]

    imported = 0
    duplicates = 0
    if not dry_run:
        for record in records:
            if _insert_archive_source(db_path, record):
                imported += 1
            else:
                duplicates += 1

    by_bucket: dict[str, int] = {}
    by_sensitivity: dict[str, int] = {}
    for record in records:
        by_bucket[record.person_name] = by_bucket.get(record.person_name, 0) + 1
        by_sensitivity[record.sensitivity] = by_sensitivity.get(record.sensitivity, 0) + 1

    return WeChatArchiveImportResult(
        scanned_count=scanned,
        parsed_count=len(records),
        imported_count=imported,
        duplicate_count=duplicates,
        skipped_sensitive_count=skipped_sensitive,
        skipped_low_score_count=skipped_low_score,
        skipped_unmatched_count=skipped_unmatched,
        by_bucket=by_bucket,
        by_sensitivity=by_sensitivity,
        dry_run=dry_run,
    )


def render_wechat_archive_import_markdown(result: WeChatArchiveImportResult) -> str:
    prefix = "dry-run" if result.dry_run else "imported"
    lines = [
        "# 微信归档文件线索导入摘要",
        "",
        f"- 模式：{prefix}",
        f"- 文件清单扫描：{result.scanned_count}",
        f"- 文件线索选中：{result.parsed_count}",
        f"- 文件线索导入：{result.imported_count}",
        f"- 重复：{result.duplicate_count}",
        f"- 跳过高敏感：{result.skipped_sensitive_count}",
        f"- 跳过低分：{result.skipped_low_score_count}",
        f"- 跳过未匹配：{result.skipped_unmatched_count}",
        "",
        "## 文件线索分桶",
        "",
    ]
    if result.by_bucket:
        for name, count in sorted(result.by_bucket.items(), key=lambda item: (-item[1], item[0])):
            lines.append(f"- {name}: {count}")
    else:
        lines.append("- 暂无。")
    lines.extend(["", "## 敏感级别", ""])
    if result.by_sensitivity:
        for name, count in sorted(result.by_sensitivity.items()):
            lines.append(f"- {name}: {count}")
    else:
        lines.append("- 暂无。")
    return "\n".join(lines).rstrip() + "\n"


def delete_wechat_archive_sources(db_path: Path | str) -> int:
    init_db(db_path)
    with connect(db_path) as conn:
        cursor = conn.execute(
            "delete from relationship_sources where source_type = ?",
            (ARCHIVE_SOURCE_TYPE,),
        )
        conn.commit()
        return int(cursor.rowcount)


def _read_manifest_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise ValueError(f"WeChat archive manifest does not exist: {path}")
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def _record_from_row(
    row: dict[str, str],
    *,
    known_contacts: list[str] | tuple[str, ...],
    imported_at: str,
    include_unmatched: bool,
) -> WeChatArchiveRecord | None:
    filename = (row.get("filename") or "").strip()
    if not filename:
        return None
    archive_path = (row.get("archive_path") or row.get("path") or "").strip()
    modified = (row.get("modified") or "").strip()
    extension = (row.get("extension") or Path(filename).suffix.lstrip(".")).strip().lower()
    size_mib = (row.get("size_mib") or "").strip()
    month = (row.get("month") or "").strip()
    sensitivity = _sensitivity(filename)
    contact = _match_known_contact(filename, known_contacts)
    if not contact and not include_unmatched:
        return None
    person_name = contact or _topic_bucket(filename)
    person_name = person_name or "微信归档线索"
    score = _score_archive_item(
        filename,
        matched_contact=bool(contact),
        sensitivity=sensitivity,
        extension=extension,
        modified=modified,
    )
    fields = {
        "archive_path": archive_path,
        "extension": extension,
        "size_mib": size_mib,
        "month": month,
        "sensitivity": sensitivity,
        "score": str(score),
    }
    if contact:
        fields["matched_contact"] = contact
    summary = _summary(filename, extension=extension, size_mib=size_mib, modified=modified, sensitivity=sensitivity)
    raw_text = json.dumps({key: value for key, value in row.items() if value}, ensure_ascii=False, sort_keys=True)
    stable = "\n".join([person_name, filename, modified, archive_path, raw_text])
    return WeChatArchiveRecord(
        person_name=person_name,
        title=f"微信归档：{filename}",
        occurred_at=_modified_to_iso(modified),
        summary=summary,
        fields={key: value for key, value in fields.items() if value},
        raw_text=raw_text,
        file_path=archive_path or None,
        text_hash=hashlib.sha256(stable.encode("utf-8")).hexdigest(),
        imported_at=imported_at,
        score=score,
        sensitivity=sensitivity,
    )


def _insert_archive_source(db_path: Path | str, record: WeChatArchiveRecord) -> bool:
    with connect(db_path) as conn:
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
            (record.person_name, record.imported_at, record.imported_at, record.occurred_at),
        )
        cursor = conn.execute(
            """
            insert or ignore into relationship_sources
            (person_name, source_type, title, occurred_at, summary, fields_json,
             raw_text, file_path, text_hash, imported_at, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.person_name,
                ARCHIVE_SOURCE_TYPE,
                record.title,
                record.occurred_at,
                record.summary,
                json.dumps(record.fields, ensure_ascii=False, sort_keys=True),
                record.raw_text,
                record.file_path,
                record.text_hash,
                record.imported_at,
                record.imported_at,
                record.imported_at,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0


def _match_known_contact(filename: str, known_contacts: list[str] | tuple[str, ...]) -> str | None:
    normalized_filename = _normalize(filename)
    for contact in sorted({item.strip() for item in known_contacts if item.strip()}, key=len, reverse=True):
        if not _is_matchable_contact_name(contact):
            continue
        if _normalize(contact) in normalized_filename:
            return contact
    return None


def _is_matchable_contact_name(value: str) -> bool:
    cleaned = value.strip()
    normalized = _normalize(cleaned)
    if len(normalized) < 2:
        return False
    if cleaned in GENERIC_CONTACT_NAMES:
        return False
    if re.fullmatch(r"[+\-\d.\s]+", cleaned):
        return False
    if re.search(r"(积分|ChatGPT|GPT|Pro[〉>])", cleaned, flags=re.IGNORECASE):
        return False
    return True


def _topic_bucket(filename: str) -> str | None:
    for keyword, bucket in TOPIC_BUCKETS:
        if keyword.casefold() in filename.casefold():
            return bucket
    if any(keyword in filename for keyword in RELATIONSHIP_KEYWORDS):
        return "微信归档线索"
    return None


def _sensitivity(filename: str) -> str:
    if any(keyword in filename for keyword in SENSITIVE_KEYWORDS):
        return "high"
    return "normal"


def _score_archive_item(
    filename: str,
    *,
    matched_contact: bool,
    sensitivity: str,
    extension: str,
    modified: str,
) -> int:
    score = 0
    if matched_contact:
        score += 35
    score += 12 * sum(1 for keyword in RELATIONSHIP_KEYWORDS if keyword in filename)
    if _topic_bucket(filename):
        score += 18
    if extension in {"pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "md", "txt"}:
        score += 8
    if modified.startswith(("2025", "2026")):
        score += 8
    if sensitivity == "high":
        score -= 20
    return max(score, 0)


def _summary(
    filename: str,
    *,
    extension: str,
    size_mib: str,
    modified: str,
    sensitivity: str,
) -> str:
    parts = [filename]
    if extension:
        parts.append(f"类型：{extension}")
    if size_mib:
        parts.append(f"大小：{size_mib} MiB")
    if modified:
        parts.append(f"修改：{modified}")
    if sensitivity == "high":
        parts.append("高敏感，默认不进入驾驶舱")
    return "；".join(parts)


def _modified_to_iso(value: str) -> str | None:
    if not value:
        return None
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})", value.strip())
    if match:
        parsed = datetime.strptime(f"{match.group(1)} {match.group(2)}", "%Y-%m-%d %H:%M:%S")
        return parsed.astimezone().isoformat(timespec="seconds")
    return value


def _normalize(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()
