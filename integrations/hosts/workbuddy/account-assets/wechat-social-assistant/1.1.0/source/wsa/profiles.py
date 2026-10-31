from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field, replace
from pathlib import Path
import re

from .enrichment import ContactEnrichment, enrichment_by_person
from .observations import OCRObservation
from .parser import TIME_RE, extract_signals, is_noise_line
from .sources import RelationshipSource, sources_by_person
from .store import connect
from .timefmt import format_display_time


URL_RE = re.compile(r"https?://[^\s，。！？）)]+")
FILE_RE = re.compile(r"[\w\u4e00-\u9fff（）()\-—_ ]+\.(?:docx?|xlsx?|pptx?|pdf|md|txt|zip|png|jpe?g)", re.IGNORECASE)
FILE_SIZE_RE = re.compile(r"^\d+(?:\.\d+)?\s*[KMGT]B?$", re.IGNORECASE)
ORG_RE = re.compile(
    r"[\u4e00-\u9fffA-Za-z0-9（）()·]{2,24}(?:资本|基金|投资|证券|银行|科技|公司|集团|大学|学院|研究院|国发院|实验室|中心)"
)
ORG_CONTEXT_RE = re.compile(r"(我是|来自|就职|任职|加入|供职|创始|合伙|负责|@)")
CHINESE_NAME_RE = re.compile(r"^[\u4e00-\u9fff]{2,4}$")
LATIN_NAME_HINT_RE = re.compile(
    r"^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,2})(?:\s+[A-Za-z0-9]{2,8})?$"
)
IDENTITY_CONTEXT_RE = re.compile(r"(我是\s*(?!怎么|如何|怎样)|本人|幸会|名片)")
RELATIVE_TIME_RE = re.compile(r"^(昨天|今天|前天)?\s*\d{1,2}:\d{2}$")
NON_PERSON_LABELS = {"人工智能", "机器学习", "产品方向", "项目方向", "项目内容", "项目资料"}
NON_PERSON_SUFFIXES = ("方向", "内容", "资料", "方案", "项目", "工作", "问题", "消息", "时间", "链接", "文件")
SYMBOL_NOISE_RE = re.compile(r"^[^\w\u4e00-\u9fff]{1,8}$")
SHORT_OCR_GARBAGE_RE = re.compile(r"^(?=.*[~∞§•])(?=.*\d).{1,8}$")
SYMBOL_PREFIX_OCR_GARBAGE_RE = re.compile(r"^[§∞•][A-Za-z0-9]?\S{1,12}$")
SENTENCE_END_RE = re.compile(r"[。！？!?；;：:）).]$")
LATIN_OR_DIGIT_RE = re.compile(r"[A-Za-z0-9]")
LOW_VALUE_PATTERNS = (
    re.compile(r"Moonshot|开放平台用户|账户已不足|帐户状态|账户状态|影响业务使用"),
    re.compile(r"^[A-Z]（?$"),
    re.compile(r"^[A-Za-z0-9]+[.。…]+$"),
)
ACTION_KEYWORDS = (
    "哪些",
    "什么",
    "怎么",
    "哪里",
    "是否",
    "需要",
    "提供",
    "推出",
    "支持",
    "工作",
    "方向",
    "想法",
    "研究",
    "同意",
    "先做",
    "学习",
)
QUESTION_KEYWORDS = ("哪些", "什么", "怎么", "哪里", "是否")
SIGNAL_LABELS = {
    "needs_reply": "待回复",
    "schedule": "约时间",
    "birthday": "生日",
    "project": "项目/合作",
    "question": "问题",
    "thanks": "感谢",
}


@dataclass(frozen=True)
class ContactProfile:
    name: str
    kind: str
    source_chats: tuple[str, ...]
    last_seen_at: str
    recent_contents: tuple[str, ...]
    speakers: tuple[str, ...] = ()
    links: tuple[str, ...] = ()
    files: tuple[str, ...] = ()
    identity_hints: tuple[str, ...] = ()
    organizations: tuple[str, ...] = ()
    signals: tuple[str, ...] = ()
    last_interaction_at: str | None = None


@dataclass
class _ProfileBuilder:
    name: str
    kind: str
    source_chats: set[str] = field(default_factory=set)
    last_seen_at: str = ""
    recent_contents: list[str] = field(default_factory=list)
    speakers: set[str] = field(default_factory=set)
    links: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    identity_hints: list[str] = field(default_factory=list)
    organizations: list[str] = field(default_factory=list)
    signals: set[str] = field(default_factory=set)
    last_interaction_at: str | None = None

    def touch(self, captured_at: str) -> None:
        if not self.last_seen_at or captured_at > self.last_seen_at:
            self.last_seen_at = captured_at

    def add_recent(self, lines: list[str], *, max_items: int = 8) -> None:
        for line in lines:
            if line not in self.recent_contents:
                self.recent_contents.append(line)
        self.recent_contents = self.recent_contents[-max_items:]

    def add_links(self, links: list[str]) -> None:
        for link in links:
            if link not in self.links:
                self.links.append(link)

    def add_files(self, files: list[str]) -> None:
        for file in files:
            if file not in self.files:
                self.files.append(file)

    def add_identity_hints(self, identity_hints: list[str]) -> None:
        for identity_hint in identity_hints:
            if identity_hint not in self.identity_hints:
                self.identity_hints.append(identity_hint)

    def add_organizations(self, organizations: list[str]) -> None:
        for organization in organizations:
            if organization not in self.organizations:
                self.organizations.append(organization)

    def to_profile(self) -> ContactProfile:
        return ContactProfile(
            name=self.name,
            kind=self.kind,
            source_chats=tuple(sorted(self.source_chats)),
            last_seen_at=self.last_seen_at,
            recent_contents=tuple(self.recent_contents[-8:]),
            speakers=tuple(sorted(self.speakers)),
            links=tuple(self.links[-8:]),
            files=tuple(self.files[-8:]),
            identity_hints=tuple(self.identity_hints[-8:]),
            organizations=tuple(self.organizations[-8:]),
            signals=tuple(sorted(self.signals)),
            last_interaction_at=self.last_interaction_at,
        )


def build_profiles(db_path: Path | str, *, limit: int | None = None) -> list[ContactProfile]:
    builders: dict[tuple[str, str], _ProfileBuilder] = {}

    with connect(db_path) as conn:
        people_interaction = {
            row["name"]: row["last_interaction_at"]
            for row in conn.execute("select name, last_interaction_at from people").fetchall()
        }
        rows = conn.execute(
            """
            select c.id, p.name as chat_name, c.captured_at,
                   coalesce(c.corrected_text, c.clean_text) as clean_text
            from captures c
            join people p on p.id = c.person_id
            order by c.captured_at asc, c.id asc
            """
        ).fetchall()

    for row in rows:
        chat_name = row["chat_name"]
        if is_noise_line(chat_name):
            continue
        captured_at = row["captured_at"]
        lines = [line.strip() for line in row["clean_text"].splitlines() if line.strip()]
        source_kind = "group" if is_group_chat_name(chat_name) else "direct"
        content = important_content_lines(lines, chat_name=chat_name)
        links = extract_links(lines)
        files = extract_files(lines)
        organizations = extract_organizations(lines)
        identity_hints = (
            extract_identity_hints(lines, chat_name=chat_name, organizations=organizations)
            if source_kind == "direct"
            else []
        )
        content = filter_profile_content(
            content,
            organizations=organizations,
            identity_hints=identity_hints,
        )
        signal_kinds = {signal.kind for signal in extract_signals("\n".join(content))}

        chat_builder = _ensure_builder(builders, chat_name, source_kind)
        chat_builder.last_interaction_at = people_interaction.get(chat_name)
        chat_builder.touch(captured_at)
        chat_builder.add_recent(content)
        chat_builder.add_links(links)
        chat_builder.add_files(files)
        chat_builder.add_identity_hints(identity_hints)
        chat_builder.add_organizations(organizations)
        chat_builder.signals.update(signal_kinds)

        if source_kind == "group":
            speakers = extract_speakers(lines, chat_name=chat_name)
            chat_builder.speakers.update(speakers)
            speaker_messages = speaker_message_map(lines, chat_name=chat_name)
            speaker_artifacts = speaker_artifact_map(lines, chat_name=chat_name)
            speaker_signals = speaker_signal_map(speaker_messages)
            speaker_organizations = speaker_organization_map(speaker_messages)
            for speaker in speakers:
                speaker_links, speaker_files = speaker_artifacts.get(speaker, ([], []))
                speaker_builder = _ensure_builder(builders, speaker, "speaker")
                speaker_builder.last_interaction_at = people_interaction.get(speaker)
                speaker_builder.source_chats.add(chat_name)
                speaker_builder.touch(captured_at)
                speaker_builder.add_recent(speaker_messages.get(speaker, content[:3]))
                speaker_builder.add_links(speaker_links)
                speaker_builder.add_files(speaker_files)
                speaker_builder.add_organizations(speaker_organizations.get(speaker, []))
                speaker_builder.signals.update(speaker_signals.get(speaker, set()))

    _merge_enrichments(builders, db_path)
    _merge_sources(builders, db_path)
    profiles = [builder.to_profile() for builder in builders.values()]
    profiles.sort(key=lambda profile: (profile.last_seen_at, profile.name), reverse=True)
    if limit is not None:
        return profiles[:limit]
    return profiles


def render_profiles_markdown(
    profiles: list[ContactProfile],
    *,
    title: str = "联系人关系档案",
    empty_message: str = "暂无联系人档案。",
) -> str:
    lines = [f"# {title}", ""]
    if not profiles:
        return "\n".join(lines + [empty_message]) + "\n"
    for profile in profiles:
        lines.extend(
            [
                f"## {profile.name}",
                "",
                f"- 类型：{_kind_label(profile.kind)}",
                f"- 最近出现：{format_profile_time(profile.last_seen_at)}",
            ]
        )
        if profile.source_chats:
            lines.append(f"- 来源群/会话：{', '.join(profile.source_chats)}")
        if profile.speakers:
            lines.append(f"- 近期发言人：{', '.join(profile.speakers)}")
        if profile.signals:
            lines.append(f"- 关系信号：{', '.join(signal_label(signal) for signal in profile.signals)}")
        if profile.links:
            lines.append(f"- 链接：{', '.join(profile.links)}")
        if profile.files:
            lines.append(f"- 文件：{', '.join(profile.files)}")
        if profile.identity_hints:
            lines.append(f"- 身份线索：{', '.join(profile.identity_hints)}")
        if profile.organizations:
            lines.append(f"- 机构/公司：{', '.join(profile.organizations)}")
        lines.extend(["", "最近联系内容："])
        if profile.recent_contents:
            for item in profile.recent_contents[:6]:
                lines.append(f"- {item}")
        else:
            lines.append("- 暂无最近联系内容。")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def meaningful_content_lines(lines: list[str], *, chat_name: str | None = None) -> list[str]:
    speakers = set(extract_speakers(lines, chat_name=chat_name or ""))
    candidates: list[str] = []
    for line in lines:
        cleaned = clean_line(line)
        if not cleaned:
            continue
        if cleaned == chat_name or cleaned in speakers:
            continue
        if not is_meaningful_content_line(cleaned) and not _is_wrapped_tail_candidate(cleaned):
            continue
        candidates.append(cleaned)
    result: list[str] = []
    for line in merge_wrapped_lines(candidates):
        if is_meaningful_content_line(line) and line not in result:
            result.append(line)
    return result


def merge_wrapped_lines(lines: list[str]) -> list[str]:
    merged: list[str] = []
    for raw_line in lines:
        line = clean_line(raw_line)
        if not line:
            continue
        if merged and _should_merge_wrapped_line(merged[-1], line):
            merged[-1] = _join_wrapped_lines(merged[-1], line)
            continue
        merged.append(line)
    return merged


def important_content_lines(
    lines: list[str],
    *,
    chat_name: str | None = None,
    limit: int = 8,
) -> list[str]:
    candidates = _prefer_conversation_lines(meaningful_content_lines(lines, chat_name=chat_name))
    scored = [
        (_content_score(candidate), index, candidate)
        for index, candidate in enumerate(candidates)
        if not _is_low_value_line(candidate)
    ]
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [candidate for _, _, candidate in scored[:limit]]


def filter_profile_content(
    lines: list[str],
    *,
    organizations: list[str],
    identity_hints: list[str] | None = None,
) -> list[str]:
    identity_hints = identity_hints or []
    if not organizations and not identity_hints:
        return lines
    return [
        line
        for line in lines
        if not _is_standalone_organization_fragment(line)
        and not _is_standalone_identity_fragment(line, identity_hints=identity_hints)
    ]


def is_meaningful_content_line(line: str) -> bool:
    cleaned = clean_line(line)
    if not cleaned:
        return False
    if is_noise_line(cleaned) or TIME_RE.match(cleaned) or RELATIVE_TIME_RE.match(cleaned):
        return False
    if FILE_SIZE_RE.match(cleaned):
        return False
    if cleaned in {"微信电脑版", "P微信电脑版", "Logseq"}:
        return False
    if cleaned.startswith("通话时长"):
        return False
    if len(cleaned) <= 2:
        return False
    if cleaned.isdigit() and len(cleaned) > 6:
        return False
    if (
        SYMBOL_NOISE_RE.match(cleaned)
        or SHORT_OCR_GARBAGE_RE.match(cleaned)
        or SYMBOL_PREFIX_OCR_GARBAGE_RE.match(cleaned)
    ):
        return False
    if _is_low_value_line(cleaned):
        return False
    return True


def extract_speakers(lines: list[str], *, chat_name: str) -> list[str]:
    if not is_group_chat_name(chat_name):
        return []
    counts: dict[str, int] = defaultdict(int)
    for index, line in enumerate(lines[:-1]):
        candidate = clean_line(line)
        next_line = clean_line(lines[index + 1])
        if _is_speaker_name(candidate, chat_name=chat_name) and is_meaningful_content_line(next_line):
            counts[candidate] += 1
    return sorted(counts, key=lambda name: (-counts[name], name))


def annotate_speaker_candidates(
    observations: tuple[OCRObservation, ...],
    *,
    chat_name: str,
) -> tuple[OCRObservation, ...]:
    """Attach low-confidence speaker candidates while preserving OCR geometry."""

    if not is_group_chat_name(chat_name):
        return observations
    annotated: list[OCRObservation] = []
    for index, observation in enumerate(observations):
        candidate = observation.text
        next_text = observations[index + 1].text if index + 1 < len(observations) else ""
        if _is_speaker_name(candidate, chat_name=chat_name) and is_meaningful_content_line(next_text):
            ocr_confidence = observation.confidence if observation.confidence is not None else 0.55
            speaker_confidence = min(0.55, max(0.0, ocr_confidence))
            annotated.append(
                replace(
                    observation,
                    speaker_candidate=candidate,
                    speaker_confidence=speaker_confidence,
                )
            )
        else:
            annotated.append(observation)
    return tuple(annotated)


def speaker_message_map(lines: list[str], *, chat_name: str) -> dict[str, list[str]]:
    messages: dict[str, list[str]] = defaultdict(list)
    current_speaker: str | None = None
    for line in lines:
        cleaned = clean_line(line)
        if _is_speaker_boundary(cleaned):
            current_speaker = None
            continue
        if _is_speaker_name(cleaned, chat_name=chat_name):
            current_speaker = cleaned
            continue
        if current_speaker and (
            is_meaningful_content_line(cleaned) or _is_wrapped_tail_candidate(cleaned)
        ):
            messages[current_speaker].append(cleaned)
    return {
        speaker: _prefer_conversation_lines(
            [item for item in _dedupe(merge_wrapped_lines(items)) if is_meaningful_content_line(item)]
        )[:8]
        for speaker, items in messages.items()
    }


def speaker_artifact_map(lines: list[str], *, chat_name: str) -> dict[str, tuple[list[str], list[str]]]:
    artifacts: dict[str, tuple[list[str], list[str]]] = {}
    current_speaker: str | None = None
    for line in lines:
        cleaned = clean_line(line)
        if _is_speaker_boundary(cleaned):
            current_speaker = None
            continue
        if _is_speaker_name(cleaned, chat_name=chat_name):
            current_speaker = cleaned
            artifacts.setdefault(current_speaker, ([], []))
            continue
        if not current_speaker:
            continue
        speaker_links, speaker_files = artifacts.setdefault(current_speaker, ([], []))
        for link in extract_links([cleaned]):
            if link not in speaker_links:
                speaker_links.append(link)
        for file in extract_files([cleaned]):
            if file not in speaker_files:
                speaker_files.append(file)
    return artifacts


def speaker_signal_map(messages: dict[str, list[str]]) -> dict[str, set[str]]:
    return {
        speaker: {signal.kind for signal in extract_signals("\n".join(items))}
        for speaker, items in messages.items()
    }


def speaker_organization_map(messages: dict[str, list[str]]) -> dict[str, list[str]]:
    return {
        speaker: extract_organizations(items)
        for speaker, items in messages.items()
    }


def _is_speaker_boundary(line: str) -> bool:
    return bool(TIME_RE.match(line) or RELATIVE_TIME_RE.match(line))


def extract_links(lines: list[str]) -> list[str]:
    links: list[str] = []
    for line in lines:
        for match in URL_RE.findall(line):
            if match not in links:
                links.append(match)
    return links


def extract_files(lines: list[str]) -> list[str]:
    files: list[str] = []
    for line in lines:
        for match in FILE_RE.findall(line):
            file = clean_line(match)
            if file not in files:
                files.append(file)
    return files


def extract_organizations(lines: list[str]) -> list[str]:
    organizations: list[str] = []
    for line in lines:
        cleaned = clean_line(line)
        if not cleaned or _is_low_value_line(cleaned):
            continue
        for match in ORG_RE.finditer(cleaned):
            if not _has_organization_context(cleaned, match.start()):
                continue
            organization = _clean_organization(match.group(0))
            if organization and organization not in organizations:
                organizations.append(organization)
    return organizations


def extract_identity_hints(
    lines: list[str],
    *,
    chat_name: str,
    organizations: list[str],
) -> list[str]:
    if not _has_identity_context(lines, organizations=organizations):
        return []
    identity_hints: list[str] = []
    for line in lines:
        cleaned = clean_line(line)
        if not cleaned or cleaned == chat_name or _is_low_value_line(cleaned):
            continue
        hint = _extract_chinese_name_hint(cleaned) or _extract_latin_name_hint(cleaned)
        if hint and hint not in identity_hints:
            identity_hints.append(hint)
    return identity_hints


def is_group_chat_name(name: str) -> bool:
    cleaned = clean_line(name)
    return bool(re.search(r"[（(]\d+[）)]", cleaned) or cleaned.endswith("群"))


def clean_line(line: str) -> str:
    return re.sub(r"\s+", " ", line).strip()


def _ensure_builder(
    builders: dict[tuple[str, str], _ProfileBuilder],
    name: str,
    kind: str,
) -> _ProfileBuilder:
    key = (kind, name)
    if key not in builders:
        builders[key] = _ProfileBuilder(name=name, kind=kind)
    return builders[key]


def _merge_enrichments(
    builders: dict[tuple[str, str], _ProfileBuilder],
    db_path: Path | str,
) -> None:
    for name, enrichment in enrichment_by_person(db_path).items():
        matching_builders = [builder for (kind, builder_name), builder in builders.items() if builder_name == name]
        if not matching_builders:
            builder = _ensure_builder(builders, name, "manual")
            builder.touch(enrichment.updated_at or enrichment.imported_at)
            matching_builders = [builder]
        for builder in matching_builders:
            _apply_enrichment(builder, enrichment)


def _apply_enrichment(builder: _ProfileBuilder, enrichment: ContactEnrichment) -> None:
    company = enrichment.fields.get("company")
    if company:
        builder.add_organizations([company])
    hints = []
    for key, label in (
        ("role", "职位/角色"),
        ("context", "认识场景"),
        ("tags", "标签"),
    ):
        value = enrichment.fields.get(key)
        if value:
            hints.append(f"{label}：{value}")
    builder.add_identity_hints(hints)
    manual_notes = []
    for key, label in (("notes", "备注"), ("next_followup", "下次跟进")):
        value = enrichment.fields.get(key)
        if value:
            manual_notes.append(f"{label}：{value}")
    if builder.kind == "manual":
        builder.add_recent(manual_notes)


def _merge_sources(
    builders: dict[tuple[str, str], _ProfileBuilder],
    db_path: Path | str,
) -> None:
    for name, records in sources_by_person(db_path).items():
        matching_builders = [builder for (kind, builder_name), builder in builders.items() if builder_name == name]
        if not matching_builders:
            builder = _ensure_builder(builders, name, "source")
            builder.touch(_source_time(records[0]))
            matching_builders = [builder]
        for builder in matching_builders:
            for record in records:
                builder.touch(_source_time(record))
                _apply_relationship_source(builder, record)


def _apply_relationship_source(builder: _ProfileBuilder, source: RelationshipSource) -> None:
    organizations = _source_organizations(source)
    if organizations:
        builder.add_organizations(organizations)
    builder.add_identity_hints(_source_identity_hints(source))
    recent = _source_recent_line(source)
    if recent:
        builder.add_recent([recent])


def _source_time(source: RelationshipSource) -> str:
    return source.occurred_at or source.imported_at or source.updated_at or ""


def _source_organizations(source: RelationshipSource) -> list[str]:
    organizations = []
    for key in ("company", "org", "organization", "机构", "公司"):
        value = source.fields.get(key)
        if value and value not in organizations:
            organizations.append(value)
    return organizations


def _source_identity_hints(source: RelationshipSource) -> list[str]:
    hints = [f"来源：{source.source_type}：{source.title}"]
    for key, label in (
        ("role", "职位/角色"),
        ("title", "职位/角色"),
        ("context", "认识场景"),
        ("tags", "标签"),
        ("email", "邮箱"),
        ("phone", "电话"),
    ):
        value = source.fields.get(key)
        if value:
            hints.append(f"{label}：{value}")
    return hints


def _source_recent_line(source: RelationshipSource) -> str:
    parts = [f"{source.source_type}：{source.title}"]
    if source.summary:
        parts.append(source.summary)
    return " - ".join(parts)


def _is_speaker_name(candidate: str, *, chat_name: str) -> bool:
    if not candidate or candidate == chat_name:
        return False
    if is_noise_line(candidate) or TIME_RE.match(candidate) or RELATIVE_TIME_RE.match(candidate):
        return False
    if URL_RE.search(candidate) or FILE_RE.search(candidate) or FILE_SIZE_RE.match(candidate):
        return False
    if any(mark in candidate for mark in "，。！？?：:"):
        return False
    if len(candidate) > 18:
        return False
    if candidate in NON_PERSON_LABELS or candidate.endswith(NON_PERSON_SUFFIXES):
        return False
    if _chinese_char_count(candidate) > 5:
        return False
    if (
        SYMBOL_NOISE_RE.match(candidate)
        or SHORT_OCR_GARBAGE_RE.match(candidate)
        or SYMBOL_PREFIX_OCR_GARBAGE_RE.match(candidate)
    ):
        return False
    return True


def _chinese_char_count(value: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", value))


def _dedupe(items: list[str]) -> list[str]:
    result: list[str] = []
    for item in items:
        if item not in result:
            result.append(item)
    return result


def _clean_organization(value: str) -> str:
    cleaned = clean_line(value).strip(" ，。！？,.!?：:；;（）()")
    cleaned = re.sub(r"^(我是|来自|就职|任职|加入|供职|在)", "", cleaned)
    return cleaned.strip(" ，。！？,.!?：:；;（）()")


def _has_organization_context(line: str, start_index: int) -> bool:
    prefix = line[:start_index]
    if ORG_CONTEXT_RE.search(prefix):
        return True
    return bool(re.search(r"[A-Za-z]{3,}(?:\s+[A-Za-z]{2,})?\s*$", prefix))


def _is_standalone_organization_fragment(line: str) -> bool:
    return bool(ORG_RE.fullmatch(clean_line(line)))


def _is_standalone_identity_fragment(line: str, *, identity_hints: list[str]) -> bool:
    if not identity_hints:
        return False
    cleaned = clean_line(line)
    if cleaned in identity_hints:
        return True
    hint = _extract_chinese_name_hint(cleaned) or _extract_latin_name_hint(cleaned)
    return bool(hint and hint in identity_hints)


def _has_identity_context(lines: list[str], *, organizations: list[str]) -> bool:
    if organizations:
        return True
    return any(
        IDENTITY_CONTEXT_RE.search(clean_line(line))
        for line in lines
    )


def _extract_chinese_name_hint(line: str) -> str | None:
    cleaned = clean_line(line)
    if CHINESE_NAME_RE.fullmatch(cleaned) and not ORG_RE.fullmatch(cleaned):
        return cleaned
    return None


def _extract_latin_name_hint(line: str) -> str | None:
    match = LATIN_NAME_HINT_RE.fullmatch(clean_line(line))
    if not match:
        return None
    return match.group(1)


def _should_merge_wrapped_line(previous: str, current: str) -> bool:
    if not previous or not current:
        return False
    if URL_RE.search(previous) or URL_RE.search(current):
        return False
    if FILE_RE.search(previous) or FILE_RE.search(current):
        return False
    if is_noise_line(previous) or is_noise_line(current):
        return False
    if TIME_RE.match(current) or RELATIVE_TIME_RE.match(current):
        return False
    if SENTENCE_END_RE.search(previous):
        return False
    if _is_low_value_line(previous) or _is_low_value_line(current):
        return False
    if _has_open_ending(previous):
        return True
    if _is_short_tail(current) and len(previous) >= 10:
        return True
    if LATIN_OR_DIGIT_RE.search(previous[-1:]) and LATIN_OR_DIGIT_RE.match(current):
        return True
    if _starts_new_sentence(current):
        return False
    return len(previous) >= 28 and len(current) <= 24


def _has_open_ending(line: str) -> bool:
    open_endings = (
        "和",
        "与",
        "及",
        "或",
        "把",
        "成",
        "用",
        "为",
        "是",
        "在",
        "向",
        "对",
        "给",
        "让",
        "再",
        "什",
        "工",
    )
    return line.endswith(open_endings)


def _is_short_tail(line: str) -> bool:
    return len(line) <= 4 and bool(re.search(r"[\u4e00-\u9fff]", line))


def _is_wrapped_tail_candidate(line: str) -> bool:
    if TIME_RE.match(line) or RELATIVE_TIME_RE.match(line):
        return False
    if is_noise_line(line) or SYMBOL_NOISE_RE.match(line) or SYMBOL_PREFIX_OCR_GARBAGE_RE.match(line):
        return False
    return _is_short_tail(line)


def _starts_new_sentence(line: str) -> bool:
    return bool(
        re.match(
            r"^(我|你|他|她|它|我们|你们|他们|她们|这个|这家|那|好呀|可以|同意|谢谢|感谢)",
            line,
        )
    )


def _join_wrapped_lines(previous: str, current: str) -> str:
    if LATIN_OR_DIGIT_RE.search(previous[-1:]) or LATIN_OR_DIGIT_RE.match(current):
        return f"{previous} {current}"
    return previous + current


def _kind_label(kind: str) -> str:
    return {
        "group": "群聊",
        "direct": "私聊/单聊",
        "speaker": "群内联系人",
        "manual": "手工补充",
        "source": "多入口来源",
    }.get(kind, kind)


def signal_label(signal: str) -> str:
    return SIGNAL_LABELS.get(signal, signal)


def format_profile_time(value: str) -> str:
    return format_display_time(value)


def _content_score(line: str) -> int:
    score = 0
    if "？" in line or "?" in line:
        score += 50
    if any(keyword in line for keyword in QUESTION_KEYWORDS):
        score += 40
    if "政策" in line or "支持" in line:
        score += 40
    score += sum(12 for keyword in ACTION_KEYWORDS if keyword in line)
    if URL_RE.search(line):
        score += 10
    if FILE_RE.search(line):
        score += 6
    if len(line) >= 12:
        score += 10
    if len(line) >= 28:
        score += 5
    return score


def _is_low_value_line(line: str) -> bool:
    return any(pattern.search(line) for pattern in LOW_VALUE_PATTERNS)


def _is_standalone_artifact_line(line: str) -> bool:
    cleaned = clean_line(line)
    return bool(URL_RE.fullmatch(cleaned) or FILE_RE.fullmatch(cleaned))


def _prefer_conversation_lines(lines: list[str]) -> list[str]:
    return [line for line in lines if not _is_standalone_artifact_line(line)]
