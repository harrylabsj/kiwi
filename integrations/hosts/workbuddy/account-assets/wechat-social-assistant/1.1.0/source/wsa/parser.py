from __future__ import annotations

from dataclasses import dataclass
import re


NOISE_LINES = {
    "搜索",
    "Q 搜索",
    "发送",
    "聊天信息",
    "表情",
    "文件",
    "图片",
    "视频",
    "语音",
    "按住说话",
    "输入",
    "微信",
    "通讯录",
    "发现",
    "我",
    "收藏",
    "Codex",
}

TIME_RE = re.compile(
    r"^((\d{1,2}:\d{2})|(昨天|今天|星期[一二三四五六日天])\s*\d{0,2}:?\d{0,2}|"
    r"(\d{4}[/-]\d{1,2}[/-]\d{1,2})|(\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2})|"
    r"(\d{1,2}月\d{1,2}日))$"
)

NOISE_PATTERNS = (
    re.compile(r"^微信\s+文件(?:\s+编辑)?(?:\s+显示)?(?:\s+窗口)?(?:\s*帮助)?$"),
    re.compile(r"^(文件|编辑|显示|窗口|帮助)(\s+(文件|编辑|显示|窗口|帮助))*$"),
    re.compile(r"^[QG0-9∞\s]*\d{1,2}月\d{1,2}日\s*周[一二三四五六日天]\s*\d{1,2}:?\d{2}$"),
    re.compile(r"^\d+\s*KB/s(\s+\d+\s*KB/s)?$"),
    re.compile(r"^Q\s*搜索$"),
    re.compile(r"^你已添加了.+以上是打招呼的消息。?$"),
)


@dataclass(frozen=True)
class Signal:
    kind: str
    phrase: str


@dataclass(frozen=True)
class ParsedCapture:
    contact_name: str
    clean_text: str
    lines: list[str]
    signals: list[Signal]

    @property
    def signal_kinds(self) -> set[str]:
        return {signal.kind for signal in self.signals}


SIGNAL_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("needs_reply", ("没回复", "未回复", "还没回", "还没回复", "忘了回", "欠回复")),
    ("birthday", ("生日", "生快", "birthday")),
    ("schedule", ("约饭", "见面", "下周", "明天", "后天", "有空", "方便", "时间", "咖啡", "聊聊")),
    ("project", ("项目", "产品", "上线", "客户", "融资", "合作", "创业", "发布", "推进", "用得上", "方向", "先做起来", "研究一下")),
    ("thanks", ("谢谢", "感谢", "辛苦", "多谢")),
)
NEEDS_REPLY_PHRASES = ("没回复", "未回复", "还没回复", "还没回", "忘了回", "欠回复")
SECOND_PERSON_NEEDS_REPLY_RE = re.compile(r"(?:你|您).{0,8}(?:没回复|未回复|还没回复|还没回|忘了回|欠回复)")
REPLY_TO_ME_RE = re.compile(r"(?:没回复|未回复|还没回复|还没回|忘了回|欠回复).{0,8}(?:我|俺|咱)")
FIRST_PERSON_REPLY_TO_YOU_RE = re.compile(r"(?:我|我们).{0,8}(?:没回复|未回复|还没回复|还没回|忘了回|欠回复)[你您]")
SECOND_PERSON_CONTEXT_FIRST_PERSON_REPLY_RE = re.compile(
    r"(?:你|您).{0,24}(?:上次|提到|问|问题|消息|说的).{0,16}"
    r"(?:我|我们|我这边|这边).{0,8}(?:没回复|未回复|还没回复|还没回|忘了回|欠回复)"
)
FIRST_PERSON_OWN_REPLY_RE = re.compile(r"(?:我|我们).{0,8}(?:没回复|未回复|还没回复|还没回|忘了回|欠回复)")

QUESTION_PATTERNS = (
    re.compile(r"(怎么|如何|怎么样|哪些|什么|哪里|是否|能不能|可不可以).{0,24}[？?]"),
    re.compile(r"(怎么才能|怎么做|怎么处理|怎么推进|如何|怎么样|哪些工作|需要.*哪些|提供哪些|哪里来的|能不能|可不可以)"),
    re.compile(r"(问题|支持).{0,12}[？?]"),
    re.compile(r"(哪些工作|工作.{0,12}(哪些|需要|提供))"),
)

ARTICLE_TITLE_PATTERNS = (
    re.compile(r"^我是怎么把.+(?:用成|做成|接进|变成).+的$"),
)


def normalize_lines(raw_text: str) -> list[str]:
    """Clean OCR output into stable, non-empty text lines."""
    lines: list[str] = []
    previous = None
    for raw_line in raw_text.splitlines():
        line = re.sub(r"\s+", " ", raw_line).strip()
        if is_noise_line(line):
            continue
        if line == previous:
            continue
        lines.append(line)
        previous = line
    return lines


def is_noise_line(line: str) -> bool:
    cleaned = re.sub(r"\s+", " ", line).strip()
    if not cleaned or cleaned in NOISE_LINES:
        return True
    return any(pattern.match(cleaned) for pattern in NOISE_PATTERNS)


def extract_signals(text: str) -> list[Signal]:
    signals: list[Signal] = []
    seen: set[str] = set()
    lowered = text.lower()
    for kind, phrases in SIGNAL_PATTERNS:
        if kind == "needs_reply":
            phrase = _needs_reply_phrase(text)
            if phrase:
                signals.append(Signal(kind=kind, phrase=phrase))
                seen.add(kind)
            continue
        for phrase in phrases:
            target = phrase.lower()
            if target in lowered and kind not in seen:
                signals.append(Signal(kind=kind, phrase=phrase))
                seen.add(kind)
                break
    if "question" not in seen and _looks_like_question(text):
        signals.append(Signal(kind="question", phrase="question"))
    return signals


def _needs_reply_phrase(text: str) -> str | None:
    for line in normalize_lines(text):
        phrase = next((item for item in NEEDS_REPLY_PHRASES if item in line), None)
        if not phrase:
            continue
        if (
            SECOND_PERSON_NEEDS_REPLY_RE.search(line)
            or REPLY_TO_ME_RE.search(line)
            or FIRST_PERSON_REPLY_TO_YOU_RE.search(line)
            or SECOND_PERSON_CONTEXT_FIRST_PERSON_REPLY_RE.search(line)
        ):
            return phrase
        if FIRST_PERSON_OWN_REPLY_RE.search(line):
            continue
        return phrase
    return None


def _looks_like_question(text: str) -> bool:
    for line in normalize_lines(text):
        if _looks_like_article_title(line):
            continue
        if any(pattern.search(line) for pattern in QUESTION_PATTERNS):
            return True
    return False


def _looks_like_article_title(line: str) -> bool:
    return any(pattern.match(line.strip()) for pattern in ARTICLE_TITLE_PATTERNS)


def parse_capture(raw_text: str, contact_hint: str | None = None) -> ParsedCapture:
    lines = normalize_lines(raw_text)
    contact_name = (contact_hint or "").strip() or _guess_contact_name(lines)
    clean_lines = [line for line in lines if line != contact_name]
    clean_text = "\n".join(clean_lines).strip()
    signals = extract_signals(clean_text)
    return ParsedCapture(
        contact_name=contact_name,
        clean_text=clean_text,
        lines=clean_lines,
        signals=signals,
    )


def _guess_contact_name(lines: list[str]) -> str:
    for line in lines:
        if TIME_RE.match(line):
            continue
        if len(line) > 24:
            continue
        return line
    return "未知联系人"
