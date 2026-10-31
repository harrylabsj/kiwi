from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any

from .candidates import RelationshipCandidate, discover_relationship_candidates
from .profiles import ContactProfile, build_profiles
from .relationship_quality import RelationshipQualityCard, build_relationship_quality_cards
from .sources import RelationshipSource, list_relationship_sources, source_to_dict
from .store import init_db, now_iso
from .suggestions import Suggestion, build_suggestions
from .timefmt import format_display_time, normalize_datetime


COMMITMENT_ACTIONS = {"补回复", "确认时间", "项目跟进", "回答问题"}
NOISE_NAMES = {
    "时间",
    "来源",
    "项目",
    "方案",
    "合作",
    "会议",
    "报告",
    "计划",
    "有效期",
}


@dataclass(frozen=True)
class DashboardEntry:
    name: str
    kind: str
    score: int
    reason: str
    action: str = ""
    draft: str = ""
    source: str = ""
    evidence_at: str | None = None


@dataclass(frozen=True)
class RelationshipDashboard:
    as_of: str
    priority_followups: tuple[DashboardEntry, ...]
    cooling_contacts: tuple[DashboardEntry, ...]
    candidate_opportunities: tuple[DashboardEntry, ...]
    open_commitments: tuple[DashboardEntry, ...]
    high_value_groups: tuple[DashboardEntry, ...]
    noisy_groups: tuple[DashboardEntry, ...]
    source_updates: tuple[DashboardEntry, ...]
    stats: dict[str, int]


def build_relationship_dashboard(
    db_path: Path | str,
    *,
    as_of: str | None = None,
    limit: int = 8,
    min_score: int = 45,
) -> RelationshipDashboard:
    init_db(db_path)
    analysis_time = _analysis_time(as_of)
    profiles = build_profiles(db_path)
    suggestions = build_suggestions(db_path, as_of=analysis_time, limit=1000, min_score=min_score)
    all_suggestions = build_suggestions(db_path, as_of=analysis_time, limit=1000, min_score=0)
    cards = build_relationship_quality_cards(
        db_path,
        profiles=profiles,
        as_of=analysis_time,
        limit=1000,
        min_suggestion_score=0,
    )
    candidates = discover_relationship_candidates(db_path, min_confidence=45, limit=1000)
    sources = list_relationship_sources(db_path, limit=1000)

    return RelationshipDashboard(
        as_of=analysis_time,
        priority_followups=tuple(_priority_followups(suggestions, limit=limit)),
        cooling_contacts=tuple(_cooling_contacts(cards, limit=limit)),
        candidate_opportunities=tuple(_candidate_opportunities(candidates, limit=limit)),
        open_commitments=tuple(_open_commitments(all_suggestions, limit=limit)),
        high_value_groups=tuple(_high_value_groups(profiles, candidates, limit=limit)),
        noisy_groups=tuple(_noisy_groups(profiles, candidates, limit=limit)),
        source_updates=tuple(_source_updates(sources, limit=limit)),
        stats=_dashboard_stats(profiles, suggestions, candidates, sources),
    )


def render_relationship_dashboard_markdown(dashboard: RelationshipDashboard) -> str:
    lines = [
        "# 关系驾驶舱",
        "",
        f"- 分析时间：{format_display_time(dashboard.as_of)}",
        f"- 联系人档案：{dashboard.stats.get('profiles', 0)}",
        f"- 优先联系：{len(dashboard.priority_followups)}",
        f"- 新人机会：{len(dashboard.candidate_opportunities)}",
        f"- 多入口来源：{dashboard.stats.get('sources', 0)}",
    ]
    lines.extend(_section("优先联系", dashboard.priority_followups, "暂无优先联系。"))
    lines.extend(_section("降温关系", dashboard.cooling_contacts, "暂无明显降温关系。"))
    lines.extend(_section("新人机会", dashboard.candidate_opportunities, "暂无新人机会。"))
    lines.extend(_section("待处理承诺", dashboard.open_commitments, "暂无待处理承诺。"))
    lines.extend(_section("高价值群聊", dashboard.high_value_groups, "暂无高价值群聊。"))
    lines.extend(_section("噪音群聊", dashboard.noisy_groups, "暂无噪音群聊。"))
    lines.extend(_section("最新来源线索", dashboard.source_updates, "暂无多入口来源线索。"))
    return "\n".join(lines).rstrip() + "\n"


def dashboard_to_dict(dashboard: RelationshipDashboard) -> dict[str, Any]:
    return {
        "as_of": dashboard.as_of,
        "stats": dict(dashboard.stats),
        "priority_followups": [_entry_to_dict(item) for item in dashboard.priority_followups],
        "cooling_contacts": [_entry_to_dict(item) for item in dashboard.cooling_contacts],
        "candidate_opportunities": [_entry_to_dict(item) for item in dashboard.candidate_opportunities],
        "open_commitments": [_entry_to_dict(item) for item in dashboard.open_commitments],
        "high_value_groups": [_entry_to_dict(item) for item in dashboard.high_value_groups],
        "noisy_groups": [_entry_to_dict(item) for item in dashboard.noisy_groups],
        "source_updates": [_entry_to_dict(item) for item in dashboard.source_updates],
    }


def _priority_followups(suggestions: list[Suggestion], *, limit: int) -> list[DashboardEntry]:
    entries = []
    for suggestion in suggestions:
        if _is_noise_name(suggestion.person_name):
            continue
        entries.append(_entry_from_suggestion(suggestion))
        if len(entries) >= limit:
            break
    return entries


def _analysis_time(as_of: str | None) -> str:
    if not as_of:
        return now_iso()
    return normalize_datetime(as_of)


def _cooling_contacts(cards: list[RelationshipQualityCard], *, limit: int) -> list[DashboardEntry]:
    entries = [
        DashboardEntry(
            name=card.name,
            kind=card.kind,
            score=card.recency.score,
            reason=_first_reason(card.risk_flags) or card.recency.explanation,
            action=card.next_action.action,
            draft=card.next_action.draft,
            source=", ".join(card.source_chats),
            evidence_at=card.recency.evidence[0].captured_at if card.recency.evidence else None,
        )
        for card in cards
        if card.kind != "group"
        and not _is_noise_name(card.name)
        and (card.recency.score <= 35 or card.next_action.action == "恢复联系")
    ]
    entries.sort(key=lambda item: (item.score, item.name))
    return entries[:limit]


def _candidate_opportunities(candidates: list[RelationshipCandidate], *, limit: int) -> list[DashboardEntry]:
    return [
        DashboardEntry(
            name=candidate.name,
            kind="candidate",
            score=candidate.confidence,
            reason="；".join(candidate.reasons),
            action="轻量认识",
            draft=candidate.icebreaker_draft,
            source=candidate.source_chat,
            evidence_at=candidate.evidence_captured_at,
        )
        for candidate in candidates[:limit]
        if not _is_noise_name(candidate.name)
    ]


def _open_commitments(suggestions: list[Suggestion], *, limit: int) -> list[DashboardEntry]:
    commitments = [
        _entry_from_suggestion(suggestion)
        for suggestion in suggestions
        if not _is_noise_name(suggestion.person_name)
        if suggestion.action in COMMITMENT_ACTIONS
    ]
    return commitments[:limit]


def _high_value_groups(
    profiles: list[ContactProfile],
    candidates: list[RelationshipCandidate],
    *,
    limit: int,
) -> list[DashboardEntry]:
    candidate_counts = Counter(candidate.source_chat for candidate in candidates if candidate.confidence >= 55)
    entries = []
    for profile in profiles:
        if profile.kind != "group":
            continue
        signal_score = len(profile.signals) * 12
        candidate_score = candidate_counts.get(profile.name, 0) * 18
        source_score = len(profile.speakers) * 5
        score = signal_score + candidate_score + source_score
        if score < 25:
            continue
        reasons = []
        if profile.signals:
            reasons.append(f"关系信号 {len(profile.signals)} 个")
        if candidate_counts.get(profile.name):
            reasons.append(f"候选人 {candidate_counts[profile.name]} 个")
        if profile.speakers:
            reasons.append(f"近期发言人 {len(profile.speakers)} 个")
        entries.append(
            DashboardEntry(
                name=profile.name,
                kind="group",
                score=score,
                reason="；".join(reasons) or "群聊上下文较活跃",
                action="继续观察/会后跟进",
                source=profile.name,
                evidence_at=profile.last_seen_at,
            )
        )
    entries.sort(key=lambda item: (-item.score, item.name))
    return entries[:limit]


def _noisy_groups(
    profiles: list[ContactProfile],
    candidates: list[RelationshipCandidate],
    *,
    limit: int,
) -> list[DashboardEntry]:
    candidate_counts = Counter(candidate.source_chat for candidate in candidates if candidate.confidence >= 55)
    entries = []
    for profile in profiles:
        if profile.kind != "group":
            continue
        if profile.signals or candidate_counts.get(profile.name, 0) >= 2:
            continue
        entries.append(
            DashboardEntry(
                name=profile.name,
                kind="group",
                score=max(0, 50 - len(profile.recent_contents) * 4 - len(profile.speakers) * 3),
                reason="关系信号少，暂时更像低价值信息流",
                action="降频查看",
                source=profile.name,
                evidence_at=profile.last_seen_at,
            )
        )
    entries.sort(key=lambda item: (-item.score, item.name))
    return entries[:limit]


def _source_updates(sources: list[RelationshipSource], *, limit: int) -> list[DashboardEntry]:
    latest_by_person: dict[str, RelationshipSource] = {}
    for source in sources:
        if _is_noise_name(source.person_name):
            continue
        latest_by_person.setdefault(source.person_name, source)
    entries = [
        DashboardEntry(
            name=source.person_name,
            kind=source.source_type,
            score=50,
            reason=source.summary or source.title,
            action="补充画像",
            source=source.title,
            evidence_at=source.occurred_at or source.imported_at,
        )
        for source in latest_by_person.values()
    ]
    entries.sort(key=lambda item: (item.evidence_at or "", item.name), reverse=True)
    return entries[:limit]


def _dashboard_stats(
    profiles: list[ContactProfile],
    suggestions: list[Suggestion],
    candidates: list[RelationshipCandidate],
    sources: list[RelationshipSource],
) -> dict[str, int]:
    by_kind = Counter(profile.kind for profile in profiles)
    return {
        "profiles": len(profiles),
        "direct": by_kind.get("direct", 0),
        "groups": by_kind.get("group", 0),
        "speakers": by_kind.get("speaker", 0),
        "manual": by_kind.get("manual", 0),
        "source_only": by_kind.get("source", 0),
        "suggestions": len(suggestions),
        "candidates": len(candidates),
        "sources": len(sources),
    }


def _entry_from_suggestion(suggestion: Suggestion) -> DashboardEntry:
    return DashboardEntry(
        name=suggestion.person_name,
        kind="followup",
        score=suggestion.score,
        reason=suggestion.why,
        action=suggestion.action,
        draft=suggestion.draft,
        source=", ".join(suggestion.source_chats),
        evidence_at=suggestion.evidence_captured_at or suggestion.last_interaction_at,
    )


def _is_noise_name(value: str) -> bool:
    cleaned = str(value).strip()
    if not cleaned:
        return True
    if cleaned in NOISE_NAMES:
        return True
    if re.fullmatch(r"[+\-\d.\s]+", cleaned):
        return True
    if re.fullmatch(r"\d+(?:\.\d+)?元", cleaned):
        return True
    if re.fullmatch(r"\d+条新消息", cleaned):
        return True
    if re.search(r"(积分|ChatGPT|GPT|Pro[〉>])", cleaned, flags=re.IGNORECASE):
        return True
    return False


def _section(title: str, entries: tuple[DashboardEntry, ...], empty_message: str) -> list[str]:
    lines = ["", f"## {title}", ""]
    if not entries:
        lines.append(empty_message)
        return lines
    lines.extend(
        [
            "| 名称 | 分数 | 动作 | 来源 | 原因 | 草稿/备注 |",
            "|---|---:|---|---|---|---|",
        ]
    )
    for entry in entries:
        lines.append(
            f"| {_cell(entry.name)} | {entry.score} | {_cell(entry.action)} | "
            f"{_cell(entry.source)} | {_cell(_with_time(entry.reason, entry.evidence_at))} | "
            f"{_cell(entry.draft)} |"
        )
    return lines


def _with_time(reason: str, evidence_at: str | None) -> str:
    if not evidence_at:
        return reason
    return f"{reason}（{format_display_time(evidence_at)}）"


def _first_reason(reasons: tuple[str, ...]) -> str:
    return reasons[0] if reasons else ""


def _entry_to_dict(entry: DashboardEntry) -> dict[str, Any]:
    return {
        "name": entry.name,
        "kind": entry.kind,
        "score": entry.score,
        "reason": entry.reason,
        "action": entry.action,
        "draft": entry.draft,
        "source": entry.source,
        "evidence_at": entry.evidence_at,
    }


def _cell(value: str) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")
