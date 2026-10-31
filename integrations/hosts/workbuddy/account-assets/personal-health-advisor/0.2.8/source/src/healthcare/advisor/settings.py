"""Skill settings: default person, blood-pressure reference band, goals.

Stored as a 0600 JSON file in the data directory. The band and goals are the
user's own targets (typically copied from a medical order); the workbench only
draws them as reference lines and counts days, it never judges values.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .paths import settings_path, write_private_text


class SettingsError(ValueError):
    pass


GOAL_KINDS = ("bp_twice", "exercise_daily", "sleep_hours", "meditation_minutes", "medication_recorded")

DEFAULT_GOALS: list[dict[str, Any]] = [
    {"id": "bp_twice", "kind": "bp_twice", "title": "早晚各测一次血压", "note": "两次都记录才算达成"},
    {"id": "medication", "kind": "medication_recorded", "title": "按计划记录服药", "note": "每个有效计划当天都有记录"},
    {"id": "exercise", "kind": "exercise_daily", "title": "每天运动", "note": "任意一项有记录即可，冥想不计入"},
    {"id": "sleep", "kind": "sleep_hours", "title": "睡够 7 小时", "note": "按起床日计算，缺记录的日子不计入分母", "threshold": 7},
    {"id": "meditation", "kind": "meditation_minutes", "title": "冥想 10 分钟", "note": "当天冥想累计达到目标分钟数", "threshold": 10},
]

DEFAULTS: dict[str, Any] = {
    "person_id": None,
    "display_name": None,
    "vault": None,
    "timezone": "local",
    "bp_target": {"systolic": [90, 130], "diastolic": [60, 90]},
    "goals": DEFAULT_GOALS,
}

_BP_TARGET = re.compile(r"^\s*(\d{2,3})\s*-\s*(\d{2,3})\s*/\s*(\d{2,3})\s*-\s*(\d{2,3})\s*$")


def parse_bp_target(text: str) -> dict[str, list[int]]:
    match = _BP_TARGET.match(text or "")
    if not match:
        raise SettingsError("--bp-target 格式应为 90-130/60-90（收缩压下限-上限/舒张压下限-上限）")
    s_lo, s_hi, d_lo, d_hi = (int(group) for group in match.groups())
    if not (s_lo < s_hi and d_lo < d_hi and d_hi < s_hi and d_lo < s_lo):
        raise SettingsError("--bp-target 数值顺序不合理：每段下限应小于上限，舒张压应低于对应的收缩压")
    return {"systolic": [s_lo, s_hi], "diastolic": [d_lo, d_hi]}


def validate_goals(goals: Any) -> list[dict[str, Any]]:
    if not isinstance(goals, list) or not goals:
        raise SettingsError("goals 必须是非空列表")
    seen: set[str] = set()
    cleaned: list[dict[str, Any]] = []
    for item in goals:
        if not isinstance(item, dict):
            raise SettingsError("每个目标必须是对象")
        goal_id = str(item.get("id") or "").strip()
        kind = str(item.get("kind") or "").strip()
        title = str(item.get("title") or "").strip()
        if not goal_id or goal_id in seen:
            raise SettingsError("每个目标需要唯一的 id")
        if kind not in GOAL_KINDS:
            raise SettingsError(f"不支持的目标类型：{kind or '（空）'}；可用：{', '.join(GOAL_KINDS)}")
        if not title:
            raise SettingsError("每个目标需要 title")
        threshold = item.get("threshold")
        if kind in ("sleep_hours", "meditation_minutes"):
            if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or threshold <= 0:
                raise SettingsError(f"目标 {goal_id} 需要正数 threshold")
        seen.add(goal_id)
        goal = {"id": goal_id, "kind": kind, "title": title, "note": str(item.get("note") or "").strip()}
        if threshold is not None:
            goal["threshold"] = threshold
        cleaned.append(goal)
    return cleaned


def load_settings(path: Path | None = None) -> dict[str, Any]:
    path = path or settings_path()
    settings = json.loads(json.dumps(DEFAULTS))
    if not path.exists():
        return settings
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SettingsError(f"设置文件无法读取：{path.name}") from exc
    if not isinstance(raw, dict):
        raise SettingsError("设置文件格式不正确")
    for key in ("person_id", "display_name", "vault", "timezone"):
        if raw.get(key):
            settings[key] = str(raw[key])
    if isinstance(raw.get("bp_target"), dict):
        target = raw["bp_target"]
        try:
            settings["bp_target"] = {
                "systolic": [int(target["systolic"][0]), int(target["systolic"][1])],
                "diastolic": [int(target["diastolic"][0]), int(target["diastolic"][1])],
            }
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            raise SettingsError("设置中的 bp_target 不完整") from exc
    if raw.get("goals") is not None:
        settings["goals"] = validate_goals(raw["goals"])
    return settings


def save_settings(settings: dict[str, Any], path: Path | None = None) -> Path:
    path = path or settings_path()
    payload = {
        "person_id": settings.get("person_id"),
        "display_name": settings.get("display_name"),
        "vault": settings.get("vault"),
        "timezone": settings.get("timezone") or "local",
        "bp_target": settings["bp_target"],
        "goals": validate_goals(settings["goals"]),
    }
    return write_private_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
