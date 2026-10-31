from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
import re

from .parser import TIME_RE, extract_signals, is_noise_line
from .feedback import FeedbackRecord, feedback_by_person
from .profiles import (
    build_profiles,
    extract_files,
    extract_links,
    extract_organizations,
    important_content_lines,
    is_group_chat_name,
    speaker_message_map,
)
from .store import connect
from .timefmt import format_display_time, parse_datetime


ADDRESS_PREFIX_RE = re.compile(r"^(?:[\u4e00-\u9fffA-Za-z]{1,8}(?:总|老师|姐|哥|同学|先生|女士|博士|教授|经理)?[，,、]\s*){1,4}")
IDENTITY_INTRO_RE = re.compile(r"(我是\s*(?!怎么|如何|怎样)|本人|幸会|名片)")
PERSONAL_REFLECTION_RE = re.compile(r"(尝试|体验|第一步|未来|想法|能做些什么|不知道|喜欢)")
SHARED_CONTENT_RE = re.compile(r"(文章|公众号|链接|内容|分享|转发|视频|书|报告)")
POSITIVE_CONTENT_RE = re.compile(r"(有意思|不错|值得看|推荐|挺好|可以看看)")
SIGNAL_PRIORITY = ("needs_reply", "schedule", "birthday", "project", "question", "thanks")
SIGNAL_LOOKBACK_DAYS = 14


@dataclass(frozen=True)
class Suggestion:
    person_name: str
    action: str
    why: str
    draft: str
    score: int
    last_interaction_at: str
    source_chats: tuple[str, ...] = ()
    evidence_captured_at: str | None = None


def build_suggestions(
    db_path: Path | str,
    *,
    as_of: str | None = None,
    limit: int = 20,
    min_score: int = 0,
) -> list[Suggestion]:
    now = _parse_dt(as_of) if as_of else datetime.now().astimezone()
    chat_suggestions: list[Suggestion] = []

    with connect(db_path) as conn:
        people = conn.execute(
            """
            select id, name, last_interaction_at
            from people
            where last_interaction_at is not null
            """
        ).fetchall()
        for person in people:
            if is_noise_line(person["name"]):
                continue
            recent_captures = conn.execute(
                """
                select coalesce(corrected_text, clean_text) as clean_text, captured_at
                from captures
                where person_id = ?
                order by captured_at desc, id desc
                limit 5
                """,
                (person["id"],),
            ).fetchall()
            if not recent_captures:
                continue
            signal_captures = _captures_within_signal_window(
                recent_captures,
                recent_captures[0]["captured_at"],
            )
            recent_text = "\n".join(row["clean_text"] for row in signal_captures)
            signals = {signal.kind: signal.phrase for signal in extract_signals(recent_text)}
            suggestion = _suggest_for_person(
                person_name=person["name"],
                last_interaction_at=person["last_interaction_at"],
                latest_text=recent_text,
                signals=signals,
                as_of=now,
                evidence_captured_at=_evidence_captured_at(signal_captures, signals),
            )
            chat_suggestions.append(suggestion)

    speaker_suggestions = _speaker_suggestions(db_path, as_of=now, min_score=0)
    speaker_source_chats = {
        source_chat
        for suggestion in speaker_suggestions
        for source_chat in suggestion.source_chats
    }
    suggestions = [
        suggestion
        for suggestion in chat_suggestions
        if not (is_group_chat_name(suggestion.person_name) and suggestion.person_name in speaker_source_chats)
    ]
    suggestions.extend(speaker_suggestions)
    suggestions = _apply_feedback(db_path, suggestions, as_of=now)
    suggestions = [suggestion for suggestion in suggestions if suggestion.score >= min_score]
    return sorted(suggestions, key=lambda item: (-item.score, item.person_name))[:limit]


def _speaker_suggestions(db_path: Path | str, *, as_of: datetime, min_score: int) -> list[Suggestion]:
    suggestions: list[Suggestion] = []
    for profile in build_profiles(db_path):
        if profile.kind != "speaker" or not profile.source_chats or not profile.last_interaction_at:
            continue
        latest_text, signals, evidence_captured_at = _speaker_signal_context(db_path, profile)
        if not latest_text:
            continue
        suggestion = _suggest_for_person(
            person_name=profile.name,
            last_interaction_at=profile.last_interaction_at,
            latest_text=latest_text,
            signals=signals,
            as_of=as_of,
            source_chats=profile.source_chats,
            evidence_captured_at=evidence_captured_at,
        )
        if suggestion.score >= min_score:
            suggestions.append(suggestion)
    return suggestions


def _apply_feedback(
    db_path: Path | str,
    suggestions: list[Suggestion],
    *,
    as_of: datetime,
) -> list[Suggestion]:
    grouped = feedback_by_person(db_path)
    tuned: list[Suggestion] = []
    for suggestion in suggestions:
        records = grouped.get(suggestion.person_name, [])
        if _is_suppressed_by_feedback(suggestion, records, as_of=as_of):
            continue
        tuned.append(_tune_suggestion_with_feedback(suggestion, records))
    return tuned


def _is_suppressed_by_feedback(
    suggestion: Suggestion,
    records: list[FeedbackRecord],
    *,
    as_of: datetime,
) -> bool:
    for record in records:
        if record.action == "do_not_contact":
            return True
        if record.action == "snooze" and record.until_at and _parse_dt(record.until_at) > as_of:
            return True
        if record.action in {"mark_done", "not_relevant", "wrong_person", "already_close"}:
            if _feedback_covers_current_suggestion(record, suggestion):
                return True
    return False


def _feedback_covers_current_suggestion(record: FeedbackRecord, suggestion: Suggestion) -> bool:
    evidence_at = suggestion.evidence_captured_at or suggestion.last_interaction_at
    return _parse_dt(record.created_at) >= _parse_dt(evidence_at)


def _tune_suggestion_with_feedback(suggestion: Suggestion, records: list[FeedbackRecord]) -> Suggestion:
    tuned = suggestion
    if any(record.action == "too_pushy" for record in records):
        tuned = replace(
            tuned,
            score=max(0, tuned.score - 20),
            why=f"{tuned.why}；上次草稿反馈：太主动",
            draft=_soften_draft(tuned.draft),
        )
    if any(record.action == "good_draft" for record in records):
        tuned = replace(
            tuned,
            score=min(200, tuned.score + 5),
            why=f"{tuned.why}；用户反馈过类似草稿可用",
        )
    return tuned


def _soften_draft(draft: str) -> str:
    if "不急" in draft:
        return draft
    return f"{draft} 不急，你方便的时候再看就好。"


def render_markdown(
    suggestions: list[Suggestion],
    *,
    title: str = "社交跟进建议",
    empty_message: str = "暂无需要跟进的联系人。",
) -> str:
    if not suggestions:
        return f"# {title}\n\n{empty_message}\n"
    lines = [
        f"# {title}",
        "",
        "| 人 | 分数 | 强度 | 最近互动 | 建议动作 | 原因 | 微信草稿 |",
        "|---|---:|---|---|---|---|---|",
    ]
    for item in suggestions:
        lines.append(
            f"| {_cell(item.person_name)} | {item.score} | {_cell(followup_strength_label(item.score))} | "
            f"{_cell(_format_interaction_time(item.last_interaction_at))} | "
            f"{_cell(item.action)} | {_cell(item.why)} | {_cell(item.draft)} |"
        )
    return "\n".join(lines) + "\n"


def followup_strength_label(score: int) -> str:
    if score >= 100:
        return "高（需要尽快处理）"
    if score >= 45:
        return "中（有明确关系信号，适合跟进）"
    return "低（没有强关系信号，可先不主动联系或仅轻量问候）"


def _suggest_for_person(
    *,
    person_name: str,
    last_interaction_at: str,
    latest_text: str,
    signals: dict[str, str],
    as_of: datetime,
    source_chats: tuple[str, ...] = (),
    evidence_captured_at: str | None = None,
) -> Suggestion:
    days = max(0, (as_of - _parse_dt(last_interaction_at)).days)
    score = _base_score(days)
    for kind, boost in {
        "needs_reply": 150,
        "schedule": 45,
        "birthday": 40,
        "project": 30,
        "question": 25,
        "thanks": 5,
    }.items():
        if kind in signals:
            score += boost

    action = _action(days, signals)
    why = _why(days, signals, source_chats=source_chats)
    draft = _draft(person_name, action, latest_text, signals, source_chats=source_chats)
    return Suggestion(
        person_name=person_name,
        action=action,
        why=why,
        draft=draft,
        score=score,
        last_interaction_at=last_interaction_at,
        source_chats=source_chats,
        evidence_captured_at=evidence_captured_at,
    )


def _evidence_captured_at(recent_captures, signals: dict[str, str]) -> str | None:
    if not recent_captures:
        return None
    for kind in SIGNAL_PRIORITY:
        if kind not in signals:
            continue
        for capture in recent_captures:
            if any(signal.kind == kind for signal in extract_signals(capture["clean_text"])):
                return capture["captured_at"]
    return recent_captures[0]["captured_at"]


def _speaker_signal_context(db_path: Path | str, profile) -> tuple[str, dict[str, str], str | None]:
    placeholders = ", ".join("?" for _ in profile.source_chats)
    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            select p.name as chat_name,
                   coalesce(c.corrected_text, c.clean_text) as clean_text,
                   c.captured_at
            from captures c
            join people p on p.id = c.person_id
            where p.name in ({placeholders})
            order by c.captured_at desc, c.id desc
            """,
            list(profile.source_chats),
        ).fetchall()
    signal_rows = []
    for row in _captures_within_signal_window(rows, profile.last_seen_at):
        messages = speaker_message_map(
            row["clean_text"].splitlines(),
            chat_name=row["chat_name"],
        ).get(profile.name, [])
        if messages:
            signal_rows.append(
                {
                    "clean_text": "\n".join(messages),
                    "captured_at": row["captured_at"],
                }
            )
    latest_text = "\n".join(row["clean_text"] for row in signal_rows)
    if not latest_text:
        latest_text = "\n".join(profile.recent_contents)
    signals = {signal.kind: signal.phrase for signal in extract_signals(latest_text)}
    return latest_text, signals, _evidence_captured_at(signal_rows, signals)


def _captures_within_signal_window(captures, reference_captured_at: str | None):
    if not captures or not reference_captured_at:
        return list(captures)
    reference = _parse_dt(reference_captured_at)
    recent = [
        capture
        for capture in captures
        if 0 <= (reference - _parse_dt(capture["captured_at"])).days <= SIGNAL_LOOKBACK_DAYS
    ]
    return recent or [captures[0]]


def _base_score(days: int) -> int:
    if days <= 2:
        return 20
    if days <= 14:
        return 45
    if days <= 60:
        return 60
    return 50


def _action(days: int, signals: dict[str, str]) -> str:
    if "needs_reply" in signals:
        return "补回复"
    if "schedule" in signals:
        return "确认时间"
    if "birthday" in signals:
        return "送祝福"
    if "project" in signals:
        return "项目跟进"
    if "question" in signals:
        return "回答问题"
    if days >= 30:
        return "恢复联系"
    return "轻量问候"


def _why(days: int, signals: dict[str, str], *, source_chats: tuple[str, ...] = ()) -> str:
    reasons: list[str] = []
    if source_chats:
        reasons.append(f"来自群：{', '.join(source_chats)}")
    if "needs_reply" in signals:
        reasons.append("对方提到还没回复/待回应")
    if "schedule" in signals:
        reasons.append("聊天里出现约时间或见面信号")
    if "project" in signals:
        reasons.append("对方提到项目/合作进展")
    if "birthday" in signals:
        reasons.append("出现生日相关信号")
    if "question" in signals:
        reasons.append("对方抛出了问题")
    if not reasons:
        reasons.append(f"距离上次互动约 {days} 天")
    return "；".join(reasons)


def _draft(
    person_name: str,
    action: str,
    latest_text: str,
    signals: dict[str, str],
    *,
    source_chats: tuple[str, ...] = (),
) -> str:
    topic = _topic(latest_text, chat_name=person_name)
    if source_chats:
        return _speaker_draft(person_name, source_chats[0], action, topic, latest_text, signals)
    if is_group_chat_name(person_name):
        return _group_draft(action, topic, signals)
    if action == "补回复":
        return f"{person_name}，我刚补看了你上次那条，抱歉慢了。关于{topic}，我想先跟你同步一下我的想法。"
    if action == "确认时间":
        return f"{person_name}，上次说到{topic}，你这周或下周哪天方便？我们可以约个时间聊聊。"
    if action == "送祝福":
        return f"{person_name}，看到生日相关的消息，祝你生日快乐，最近也顺顺利利。"
    if action == "项目跟进":
        return f"{person_name}，上次你提到的项目后来推进得怎么样了？如果有我能帮上忙的地方，跟我说。"
    if action == "回答问题":
        return f"{person_name}，你上次问的{topic}，我想了下，可以这样看。"
    if action == "恢复联系":
        return f"{person_name}，最近突然想起之前我们聊到的{topic}，不知道你最近怎么样？"
    intro_context = _identity_intro_context(latest_text)
    if intro_context:
        return f"{person_name}，之前看到{intro_context}，幸会。最近方便简单交流一下吗？"
    reflection_context = _personal_reflection_context(topic)
    if reflection_context:
        return f"{person_name}，上次聊到{reflection_context}，最近还好吗？"
    shared_artifact_context = _shared_artifact_context(latest_text, chat_name=person_name)
    if shared_artifact_context:
        return f"{person_name}，上次你分享的{shared_artifact_context}我收到了，最近还有新的内容可以看看吗？"
    shared_content_context = _shared_content_context(latest_text, topic)
    if shared_content_context:
        return f"{person_name}，上次你提到{shared_content_context}，最近还有什么值得看的内容吗？"
    return f"{person_name}，看到你上次说到{topic}，顺手问一句：最近进展还好吗？"


def _speaker_draft(
    person_name: str,
    source_chat: str,
    action: str,
    topic: str,
    latest_text: str,
    signals: dict[str, str],
) -> str:
    if action == "补回复":
        return f"{person_name}，上次你在「{source_chat}」里提到{topic}，我刚补看了一下，想跟你同步个想法。"
    if action == "确认时间":
        return f"{person_name}，上次你在「{source_chat}」里提到{topic}，这周或下周方便继续对一下吗？"
    if action == "项目跟进":
        return f"{person_name}，上次你在「{source_chat}」里提到{topic}，这块后来推进到哪一步了？我这边可以继续补充。"
    if action == "回答问题":
        return f"{person_name}，上次你在「{source_chat}」里问到{topic}，我想了下，可以这样看。"
    if "thanks" in signals:
        return f"{person_name}，上次你在「{source_chat}」里提到{topic}，我这边也同步跟进一下。"
    shared_artifact_context = _shared_artifact_context(latest_text, chat_name=person_name)
    if shared_artifact_context:
        return f"{person_name}，上次你在「{source_chat}」里分享的{shared_artifact_context}我收到了，最近还有新的内容可以看看吗？"
    shared_content_context = _shared_content_context(latest_text, topic)
    if shared_content_context:
        return f"{person_name}，上次你在「{source_chat}」里提到{shared_content_context}，最近还有什么值得看的内容吗？"
    return f"{person_name}，上次你在「{source_chat}」里提到{topic}，最近有新进展吗？"


def _group_draft(action: str, topic: str, signals: dict[str, str]) -> str:
    if action == "补回复":
        return f"群里上次聊到{topic}，我刚补看了一下，整理个想法同步给大家。"
    if action == "确认时间":
        return f"群里上次聊到{topic}，大家这周或下周哪天方便继续对一下？"
    if action == "项目跟进":
        return f"群里上次聊到{topic}，这块后来推进到哪一步了？我这边可以继续补充。"
    if action == "回答问题":
        return f"群里上次问到{topic}，我想了下，可以这样看。"
    if action == "恢复联系":
        return f"群里之前聊到{topic}，我最近又想到一点，看看要不要继续往下推进。"
    if "thanks" in signals:
        return f"群里上次聊到{topic}，我这边也同步跟进一下。"
    return f"群里上次聊到{topic}，我这边想再确认一下：最近进展怎么样？"


def _topic(text: str, *, chat_name: str | None = None) -> str:
    for line in important_content_lines(text.splitlines(), chat_name=chat_name):
        candidate = _clean_topic(line)
        if TIME_RE.match(candidate) or is_noise_line(candidate):
            continue
        if len(candidate) >= 3:
            return _shorten_topic(candidate)
    return "这件事"


def _identity_intro_context(text: str) -> str | None:
    lines = text.splitlines()
    if not any(IDENTITY_INTRO_RE.search(line) for line in lines):
        return None
    organizations = extract_organizations(lines)
    if organizations:
        return f"你在{organizations[0]}的介绍"
    return "你的介绍"


def _personal_reflection_context(topic: str) -> str | None:
    if not PERSONAL_REFLECTION_RE.search(topic):
        return None
    if "尝试新鲜事物" in topic and "第一步" in topic:
        return "尝试新鲜事物和迈出第一步这件事"
    if "第一步" in topic and "未来" in topic:
        return "关于未来和第一步的想法"
    if "尝试" in topic:
        return "尝试新鲜事物这件事"
    if "想法" in topic:
        return "那些想法"
    return _shorten_topic(topic)


def _shared_content_context(text: str, topic: str) -> str | None:
    if not SHARED_CONTENT_RE.search(text):
        return None
    if "文章" in text:
        context = "那篇文章"
    elif "公众号" in text:
        context = "公众号里的内容"
    elif "报告" in text:
        context = "那份报告"
    elif "视频" in text:
        context = "那个视频"
    elif "书" in text:
        context = "那本书"
    else:
        context = "你分享的内容"
    if POSITIVE_CONTENT_RE.search(text) or POSITIVE_CONTENT_RE.search(topic):
        return f"{context}挺有意思"
    return context


def _shared_artifact_context(text: str, *, chat_name: str) -> str | None:
    lines = text.splitlines()
    if important_content_lines(lines, chat_name=chat_name):
        return None
    has_links = bool(extract_links(lines))
    has_files = bool(extract_files(lines))
    if has_links and has_files:
        return "链接和文件"
    if has_links:
        return "链接"
    if has_files:
        return "文件"
    return None


def _clean_topic(line: str) -> str:
    candidate = line.strip(" ，。！？,.!?")
    candidate = ADDRESS_PREFIX_RE.sub("", candidate).strip(" ，,、")
    return candidate


def _shorten_topic(candidate: str, *, max_length: int = 34) -> str:
    if len(candidate) <= max_length:
        return candidate
    return candidate[:max_length].rstrip(" ，。！？,.!?") + "..."


def _parse_dt(value: str) -> datetime:
    return parse_datetime(value)


def _format_interaction_time(value: str) -> str:
    return format_display_time(value)


def _cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", "<br>")
