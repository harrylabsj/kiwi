from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable

from .profiles import (
    ContactProfile,
    build_profiles,
    important_content_lines,
    signal_label,
    speaker_message_map,
)
from .store import connect
from .suggestions import Suggestion, build_suggestions
from .timefmt import format_display_time, parse_datetime


@dataclass(frozen=True)
class EvidenceCitation:
    source_chat: str
    captured_at: str
    source: str
    excerpt: str
    image_path: str | None = None


@dataclass(frozen=True)
class QualityScore:
    name: str
    score: int
    label: str
    explanation: str
    evidence: tuple[EvidenceCitation, ...]


@dataclass(frozen=True)
class NextAction:
    action: str
    why: str
    draft: str
    score: int
    evidence: tuple[EvidenceCitation, ...]


@dataclass(frozen=True)
class RelationshipQualityCard:
    name: str
    kind: str
    source_chats: tuple[str, ...]
    context_tags: tuple[str, ...]
    risk_flags: tuple[str, ...]
    information_gaps: tuple[str, ...]
    overall: QualityScore
    relationship_strength: QualityScore
    recency: QualityScore
    reciprocity: QualityScore
    next_action: NextAction


def build_relationship_quality_cards(
    db_path: Path | str,
    *,
    profiles: list[ContactProfile] | None = None,
    as_of: str | None = None,
    limit: int | None = None,
    min_suggestion_score: int = 45,
) -> list[RelationshipQualityCard]:
    db = Path(db_path)
    if not db.exists():
        return []
    selected_profiles = profiles if profiles is not None else build_profiles(db)
    suggestions = build_suggestions(db, as_of=as_of, limit=1000, min_score=min_suggestion_score)
    suggestions_by_person = _suggestions_by_person(suggestions)
    cards = [
        _quality_card(db, profile, suggestions_by_person.get(profile.name), as_of=as_of)
        for profile in selected_profiles
    ]
    cards.sort(key=lambda card: (card.overall.score, card.recency.score, card.name), reverse=True)
    if limit is not None:
        return cards[:limit]
    return cards


def render_relationship_quality_markdown(
    cards: list[RelationshipQualityCard],
    *,
    title: str = "关系运营台",
    empty_message: str = "暂无关系质量数据。",
) -> str:
    lines = [f"# {title}", ""]
    if not cards:
        return "\n".join(lines + [empty_message]) + "\n"

    lines.extend(
        [
            "| 人 | 总分 | 关系强度 | 最近互动 | 互惠 | 场景 | 风险 | 资料缺口 | 下一步 |",
            "|---|---:|---|---|---|---|---|---|---|",
        ]
    )
    for card in cards:
        lines.append(
            "| "
            + " | ".join(
                [
                    _cell(card.name),
                    str(card.overall.score),
                    _cell(f"{card.relationship_strength.score} / {card.relationship_strength.label}"),
                    _cell(f"{card.recency.score} / {card.recency.label}"),
                    _cell(f"{card.reciprocity.score} / {card.reciprocity.label}"),
                    _cell("；".join(card.context_tags) or "暂无明确场景"),
                    _cell("；".join(card.risk_flags) or "未发现明显风险"),
                    _cell("；".join(card.information_gaps) or "暂无明显缺口"),
                    _cell(card.next_action.action),
                ]
            )
            + " |"
        )

    for card in cards:
        lines.extend(
            [
                "",
                f"## {card.name}",
                "",
                f"- 类型：{_kind_label(card.kind)}",
                f"- 来源群/会话：{', '.join(card.source_chats) if card.source_chats else '无'}",
                f"- 场景：{'；'.join(card.context_tags) if card.context_tags else '暂无明确场景'}",
                f"- 风险：{'；'.join(card.risk_flags) if card.risk_flags else '未发现明显风险'}",
                f"- 资料缺口：{'；'.join(card.information_gaps) if card.information_gaps else '暂无明显缺口'}",
                "",
                "### 下一步",
                f"- 动作：{card.next_action.action}",
                f"- 分数：{card.next_action.score}",
                f"- 原因：{card.next_action.why}",
            ]
        )
        if card.next_action.draft:
            lines.append(f"- 草稿：{card.next_action.draft}")
        lines.extend(["", "### 评分证据"])
        for metric in (card.overall, card.relationship_strength, card.recency, card.reciprocity):
            lines.append(f"- {metric.name}：{metric.score}/100（{metric.label}）{metric.explanation}")
            for evidence in metric.evidence:
                lines.append(f"  - 证据：{_evidence_label(evidence)}")
    return "\n".join(lines).rstrip() + "\n"


def quality_card_to_dict(card: RelationshipQualityCard) -> dict:
    return {
        "name": card.name,
        "kind": card.kind,
        "source_chats": list(card.source_chats),
        "context_tags": list(card.context_tags),
        "risk_flags": list(card.risk_flags),
        "information_gaps": list(card.information_gaps),
        "scores": {
            "overall": _score_to_dict(card.overall),
            "relationship_strength": _score_to_dict(card.relationship_strength),
            "recency": _score_to_dict(card.recency),
            "reciprocity": _score_to_dict(card.reciprocity),
        },
        "next_action": {
            "action": card.next_action.action,
            "why": card.next_action.why,
            "draft": card.next_action.draft,
            "score": card.next_action.score,
            "evidence": [_evidence_to_dict(evidence) for evidence in card.next_action.evidence],
        },
    }


def _quality_card(
    db_path: Path,
    profile: ContactProfile,
    suggestion: Suggestion | None,
    *,
    as_of: str | None,
) -> RelationshipQualityCard:
    evidence = _profile_evidence(db_path, profile)
    fallback_evidence = evidence[:1] or _profile_fallback_evidence(profile)
    strength = _relationship_strength(profile, evidence=fallback_evidence)
    recency = _recency_score(profile, as_of=as_of, evidence=fallback_evidence)
    reciprocity = _reciprocity_score(profile, evidence=fallback_evidence)
    next_action = _next_action(suggestion, fallback_evidence)
    overall = _overall_score(strength, recency, reciprocity, next_action, evidence=fallback_evidence)
    return RelationshipQualityCard(
        name=profile.name,
        kind=profile.kind,
        source_chats=profile.source_chats,
        context_tags=_context_tags(profile),
        risk_flags=_risk_flags(profile, strength, recency, reciprocity),
        information_gaps=_information_gaps(profile),
        overall=overall,
        relationship_strength=strength,
        recency=recency,
        reciprocity=reciprocity,
        next_action=next_action,
    )


def _relationship_strength(profile: ContactProfile, *, evidence: tuple[EvidenceCitation, ...]) -> QualityScore:
    signal_boosts = {
        "needs_reply": 30,
        "schedule": 22,
        "birthday": 18,
        "project": 28,
        "question": 16,
        "thanks": 8,
    }
    score = 25
    score += sum(signal_boosts.get(signal, 0) for signal in profile.signals)
    if profile.recent_contents:
        score += 8
    if profile.source_chats:
        score += 6
    if profile.identity_hints or profile.organizations:
        score += 8
    if profile.kind == "direct":
        score += 6
    elif profile.kind == "group":
        score -= 8
    score = _clamp(score)
    signals = "、".join(signal_label(signal) for signal in profile.signals) if profile.signals else "暂无强关系信号"
    return QualityScore(
        name="关系强度",
        score=score,
        label=_band(score),
        explanation=f"基于关系信号、身份线索和最近内容计算；当前信号：{signals}。",
        evidence=evidence,
    )


def _recency_score(
    profile: ContactProfile,
    *,
    as_of: str | None,
    evidence: tuple[EvidenceCitation, ...],
) -> QualityScore:
    if not profile.last_interaction_at:
        return QualityScore(
            name="最近互动",
            score=0,
            label="未知",
            explanation=f"最近一次观察于 {format_display_time(profile.last_seen_at)}，但没有可确认的真实互动时间。",
            evidence=evidence,
        )
    days = _days_since(profile.last_interaction_at, as_of=as_of)
    if days <= 2:
        score = 95
    elif days <= 14:
        score = 78
    elif days <= 45:
        score = 55
    elif days <= 90:
        score = 35
    else:
        score = 15
    return QualityScore(
        name="最近互动",
        score=score,
        label=_recency_label(days),
        explanation=f"最近互动于 {format_display_time(profile.last_interaction_at)}，距分析时间约 {days} 天。",
        evidence=evidence,
    )


def _reciprocity_score(profile: ContactProfile, *, evidence: tuple[EvidenceCitation, ...]) -> QualityScore:
    score = 35
    if profile.kind == "direct":
        score += 20
    if "thanks" in profile.signals:
        score += 12
    if "question" in profile.signals:
        score += 12
    if "schedule" in profile.signals or "project" in profile.signals:
        score += 10
    if profile.kind == "speaker":
        score -= 5
    if not profile.recent_contents:
        score -= 10
    score = _clamp(score)
    return QualityScore(
        name="互惠",
        score=score,
        label=_band(score),
        explanation="根据是否有私聊、问题、感谢、约时间、协作信号估算互动是否接近双向。",
        evidence=evidence,
    )


def _overall_score(
    strength: QualityScore,
    recency: QualityScore,
    reciprocity: QualityScore,
    next_action: NextAction,
    *,
    evidence: tuple[EvidenceCitation, ...],
) -> QualityScore:
    score = round(
        strength.score * 0.40
        + recency.score * 0.30
        + reciprocity.score * 0.20
        + min(100, next_action.score) * 0.10
    )
    return QualityScore(
        name="总分",
        score=score,
        label=_band(score),
        explanation="由关系强度、最近互动、互惠和下一步可行动性加权汇总。",
        evidence=_unique_evidence(
            (*evidence, *strength.evidence[:1], *recency.evidence[:1], *reciprocity.evidence[:1], *next_action.evidence[:1])
        ),
    )


def _next_action(suggestion: Suggestion | None, evidence: tuple[EvidenceCitation, ...]) -> NextAction:
    if suggestion is None:
        return NextAction(
            action="观察/补充信息",
            why="暂无达到阈值的跟进建议，先补充身份、场景或最近互动证据。",
            draft="",
            score=0,
            evidence=evidence,
        )
    return NextAction(
        action=suggestion.action,
        why=suggestion.why,
        draft=suggestion.draft,
        score=suggestion.score,
        evidence=evidence,
    )


def _profile_evidence(db_path: Path, profile: ContactProfile, *, limit: int = 3) -> tuple[EvidenceCitation, ...]:
    chat_names = tuple(profile.source_chats) if profile.kind == "speaker" and profile.source_chats else (profile.name,)
    if not chat_names:
        return ()
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
    citations: list[EvidenceCitation] = []
    for row in rows:
        excerpt = _evidence_excerpt(row["clean_text"], profile, chat_name=row["chat_name"])
        if not excerpt:
            continue
        citations.append(
            EvidenceCitation(
                source_chat=row["chat_name"],
                captured_at=row["captured_at"],
                source=row["source"],
                image_path=row["image_path"],
                excerpt=excerpt,
            )
        )
        if len(citations) >= limit:
            break
    return tuple(citations)


def _evidence_excerpt(clean_text: str, profile: ContactProfile, *, chat_name: str) -> str:
    lines = [line.strip() for line in clean_text.splitlines() if line.strip()]
    if profile.kind == "speaker":
        messages = speaker_message_map(lines, chat_name=chat_name).get(
            profile.name,
            [],
        )
        return _compact_excerpt(messages)
    return _compact_excerpt(important_content_lines(lines, chat_name=chat_name) or profile.recent_contents)


def _profile_fallback_evidence(profile: ContactProfile) -> tuple[EvidenceCitation, ...]:
    excerpt = _compact_excerpt(profile.recent_contents) or profile.name
    return (
        EvidenceCitation(
            source_chat=profile.source_chats[0] if profile.source_chats else profile.name,
            captured_at=profile.last_seen_at,
            source="profile",
            excerpt=excerpt,
            image_path=None,
        ),
    )


def _context_tags(profile: ContactProfile) -> tuple[str, ...]:
    tags: list[str] = []
    tags.append(_kind_label(profile.kind))
    tags.extend(f"来源：{source}" for source in profile.source_chats[:3])
    tags.extend(signal_label(signal) for signal in profile.signals)
    tags.extend(profile.organizations[:2])
    if profile.identity_hints:
        tags.append("有身份线索")
    if profile.links:
        tags.append("有链接资料")
    if profile.files:
        tags.append("有文件资料")
    return _dedupe(tags)


def _risk_flags(
    profile: ContactProfile,
    strength: QualityScore,
    recency: QualityScore,
    reciprocity: QualityScore,
) -> tuple[str, ...]:
    flags: list[str] = []
    if profile.kind == "speaker":
        flags.append("仅群聊上下文，主动联系前需要保持克制")
    if profile.kind == "group":
        flags.append("群聊不是单个联系人，避免把群名当作个人称呼")
    if "needs_reply" in profile.signals:
        flags.append("存在待回复信号，延迟可能伤害关系")
    if recency.score <= 35:
        flags.append("最近互动偏久，开场需要轻量")
    if strength.score < 45:
        flags.append("关系信号较弱，避免高承诺邀约")
    if reciprocity.score < 45:
        flags.append("互惠证据不足，建议先观察或补充上下文")
    return _dedupe(flags)


def _information_gaps(profile: ContactProfile) -> tuple[str, ...]:
    gaps: list[str] = []
    if profile.kind == "speaker":
        gaps.append("缺少私聊互动证据")
    if profile.kind != "group" and not profile.identity_hints and not profile.organizations:
        gaps.append("缺少身份/机构线索")
    if not profile.recent_contents:
        gaps.append("缺少可读的最近联系内容")
    if not profile.signals:
        gaps.append("缺少明确关系信号")
    return _dedupe(gaps)


def _suggestions_by_person(suggestions: list[Suggestion]) -> dict[str, Suggestion]:
    result: dict[str, Suggestion] = {}
    for suggestion in suggestions:
        result.setdefault(suggestion.person_name, suggestion)
    return result


def _score_to_dict(score: QualityScore) -> dict:
    return {
        "name": score.name,
        "score": score.score,
        "label": score.label,
        "explanation": score.explanation,
        "evidence": [_evidence_to_dict(evidence) for evidence in score.evidence],
    }


def _evidence_to_dict(evidence: EvidenceCitation) -> dict:
    return {
        "source_chat": evidence.source_chat,
        "captured_at": evidence.captured_at,
        "source": evidence.source,
        "excerpt": evidence.excerpt,
        "image_path": evidence.image_path,
    }


def _days_since(value: str, *, as_of: str | None) -> int:
    seen_at = _parse_dt(value)
    now = _parse_dt(as_of) if as_of else datetime.now().astimezone()
    return max(0, (now - seen_at).days)


def _parse_dt(value: str | None) -> datetime:
    if not value:
        return datetime.now().astimezone()
    return parse_datetime(value)


def _compact_excerpt(lines: Iterable[str], *, max_length: int = 120) -> str:
    text = " ".join(line.strip() for line in lines if line and line.strip())
    if len(text) <= max_length:
        return text
    return text[: max_length - 1].rstrip() + "…"


def _unique_evidence(evidence: tuple[EvidenceCitation, ...]) -> tuple[EvidenceCitation, ...]:
    result: list[EvidenceCitation] = []
    seen: set[tuple[str, str, str]] = set()
    for item in evidence:
        key = (item.source_chat, item.captured_at, item.excerpt)
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return tuple(result[:3])


def _evidence_label(evidence: EvidenceCitation) -> str:
    image = f" / 截图：{evidence.image_path}" if evidence.image_path else ""
    return f"{evidence.source_chat} / {format_display_time(evidence.captured_at)} / {evidence.excerpt}{image}"


def _kind_label(kind: str) -> str:
    return {
        "direct": "私聊/单聊",
        "group": "群聊",
        "speaker": "群内联系人",
        "manual": "手工补充",
        "source": "多入口来源",
    }.get(kind, kind)


def _band(score: int) -> str:
    if score >= 75:
        return "强"
    if score >= 55:
        return "中"
    if score >= 35:
        return "弱"
    return "冷"


def _recency_label(days: int) -> str:
    if days <= 2:
        return "很近"
    if days <= 14:
        return "近期"
    if days <= 45:
        return "稍久"
    return "冷却"


def _clamp(score: int) -> int:
    return max(0, min(100, score))


def _dedupe(values: Iterable[str]) -> tuple[str, ...]:
    result: list[str] = []
    for value in values:
        if value and value not in result:
            result.append(value)
    return tuple(result)


def _cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
