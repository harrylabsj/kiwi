from __future__ import annotations

from datetime import datetime


def parse_datetime(value: str) -> datetime:
    text = value.strip()
    if not text:
        raise ValueError("datetime value is required")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid ISO timestamp or date: {value}") from exc
    return parsed.astimezone()


def normalize_datetime(value: str) -> str:
    return parse_datetime(value).isoformat(timespec="seconds")


def format_display_time(value: str) -> str:
    try:
        return parse_datetime(value).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return value
