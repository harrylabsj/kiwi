from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re

from .enrichment import FIELD_BY_LABEL, list_contact_enrichments, record_contact_enrichment


@dataclass(frozen=True)
class ParsedObsidianContact:
    person_name: str
    fields: dict[str, str]
    raw_text: str
    file_path: Path


@dataclass(frozen=True)
class ObsidianImportResult:
    scanned_count: int
    parsed_count: int
    imported_count: int
    dry_run: bool = False


def parse_obsidian_contact_file(path: Path | str) -> ParsedObsidianContact:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    person_name = _title_from_markdown(text) or file_path.stem
    fields = _manual_fields(text)
    return ParsedObsidianContact(
        person_name=person_name,
        fields=fields,
        raw_text=text,
        file_path=file_path,
    )


def import_obsidian_enrichments(
    db_path: Path | str,
    *,
    vault: Path | str,
    dry_run: bool = False,
    imported_at: str | None = None,
) -> ObsidianImportResult:
    people_dir = Path(vault) / "社交圈" / "人脉"
    files = _contact_files(people_dir)
    parsed_contacts = [parse_obsidian_contact_file(path) for path in files]
    importable = [contact for contact in parsed_contacts if contact.fields]
    if not dry_run:
        for contact in importable:
            record_contact_enrichment(
                db_path,
                person_name=contact.person_name,
                fields=contact.fields,
                raw_text=contact.raw_text,
                file_path=str(contact.file_path),
                imported_at=imported_at,
            )
    return ObsidianImportResult(
        scanned_count=len(files),
        parsed_count=len(importable),
        imported_count=0 if dry_run else len(importable),
        dry_run=dry_run,
    )


def _contact_files(people_dir: Path) -> list[Path]:
    if not people_dir.exists():
        return []
    return sorted(path for path in people_dir.glob("*.md") if path.stem != "索引")


def _title_from_markdown(text: str) -> str | None:
    for line in text.splitlines():
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            return match.group(1).strip()
    return None


def _manual_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    in_manual_section = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line == "## 手工补充":
            in_manual_section = True
            continue
        if in_manual_section and line.startswith("## "):
            in_manual_section = False
            continue
        if not in_manual_section or not line.startswith("- "):
            continue
        match = re.match(r"^-\s*([^：:]+)[：:]\s*(.*?)\s*$", line)
        if not match:
            continue
        label = match.group(1).strip()
        value = match.group(2).strip()
        key = FIELD_BY_LABEL.get(label)
        if key and value:
            fields[key] = value
    return fields
