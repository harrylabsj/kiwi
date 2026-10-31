from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_WATCH_INTERVAL_SECONDS = 60
MIN_WATCH_INTERVAL_SECONDS = 5


@dataclass(frozen=True)
class WSASettings:
    watch_interval_seconds: int = DEFAULT_WATCH_INTERVAL_SECONDS


def settings_path_for_db(db_path: Path) -> Path:
    return Path(db_path).parent / "settings.json"


def load_settings(db_path: Path) -> WSASettings:
    path = settings_path_for_db(db_path)
    if not path.exists():
        return WSASettings()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return WSASettings()
    return WSASettings(watch_interval_seconds=_coerce_interval(payload.get("watch_interval_seconds"), strict=False))


def save_watch_interval(db_path: Path, seconds: int) -> WSASettings:
    interval = _coerce_interval(seconds, strict=True)
    settings = WSASettings(watch_interval_seconds=interval)
    path = settings_path_for_db(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"watch_interval_seconds": settings.watch_interval_seconds}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return settings


def _coerce_interval(value: Any, *, strict: bool) -> int:
    try:
        interval = int(value)
    except (TypeError, ValueError):
        return DEFAULT_WATCH_INTERVAL_SECONDS
    if interval < MIN_WATCH_INTERVAL_SECONDS:
        if not strict:
            return DEFAULT_WATCH_INTERVAL_SECONDS
        raise ValueError(f"watch interval must be >= {MIN_WATCH_INTERVAL_SECONDS} seconds")
    return interval
