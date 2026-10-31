"""Deterministic workbench model built from confirmed Vault records.

Everything here is counting and grouping. No value is judged as normal or
abnormal: the blood-pressure band comes from the user's own settings and is
only reported as "inside/outside the band"; missing records are reported as
missing, never as zero, skipped, or healthy.
"""

from __future__ import annotations

import re
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from ..parser import _FIELD_LABELS

WEEKDAYS = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")
CONTEXT_LABELS = {
    "current": "当前", "suspected": "疑似", "ruled_out": "已排除",
    "history": "既往", "family_history": "家族史", "other": "其他",
}
MEDITATION_MARKERS = ("冥想", "打坐", "静坐", "正念")
_COUNT_TOTAL = re.compile(r"共\s*(\d+)\s*(个|次)")
_COUNT_ANY = re.compile(r"(\d+)\s*(个|次)")


def day_keys(today: date, days: int) -> list[str]:
    return [(today - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]


def note_count(note: str | None) -> tuple[int, str] | None:
    """Count-type exercise stored in the note: "共 93 个" or "第一组 50 个，第二组 43 个"."""
    text = note or ""
    total = _COUNT_TOTAL.search(text)
    if total:
        return int(total.group(1)), total.group(2)
    matches = _COUNT_ANY.findall(text)
    if not matches:
        return None
    return sum(int(number) for number, _ in matches), matches[0][1]


def _hour(timestamp: str | None) -> int | None:
    if not timestamp or len(timestamp) < 13:
        return None
    try:
        return int(timestamp[11:13])
    except ValueError:
        return None


def bp_slot(vital: dict[str, Any]) -> str:
    """Morning = before noon, evening = noon onwards; explicit context wins."""
    period = str((vital.get("context") or {}).get("period") or "")
    if period:
        return "morning" if any(marker in period for marker in ("晨", "早", "上午")) else "evening"
    hour = _hour(vital.get("measured_at"))
    if hour is None:
        return "evening"
    return "morning" if hour < 12 else "evening"


def _in_band(value: int | float, band: list[int]) -> bool:
    return band[0] <= value <= band[1]


def _md(iso: str) -> str:
    return f"{int(iso[5:7])}/{int(iso[8:10])}"


def _days_ago_label(days: int) -> tuple[str, str]:
    if days == 0:
        return "今天", "good"
    if days == 1:
        return "昨天", "good"
    return f"{days} 天前", "warn" if days <= 3 else "none"


def build_bp(vitals: list[dict[str, Any]], keys: list[str], band: dict[str, list[int]]) -> dict[str, Any]:
    series: dict[str, dict[str, dict[str, Any]]] = {"morning": {}, "evening": {}}
    per_day_counts: dict[str, int] = defaultdict(int)
    readings: list[tuple[str, str, dict[str, Any]]] = []
    for vital in sorted(vitals, key=lambda item: item.get("measured_at") or ""):
        sys_v, dia_v = vital.get("systolic_mmHg"), vital.get("diastolic_mmHg")
        measured_at = vital.get("measured_at") or ""
        day = measured_at[:10]
        if sys_v is None or dia_v is None or day not in keys:
            continue
        slot = bp_slot(vital)
        per_day_counts[day] += 1
        reading = {
            "sys": int(sys_v), "dia": int(dia_v), "time": measured_at[11:16] or "",
            "hr": vital.get("heart_rate_bpm"),
            "in_band": _in_band(sys_v, band["systolic"]) and _in_band(dia_v, band["diastolic"]),
        }
        readings.append((slot, day, reading))
        # The chart has one x-position per day. It plots the last reading in
        # a slot, while all readings remain part of the statistics.
        previous = series[slot].get(day)
        reading["sample_count"] = int(previous.get("sample_count", 0)) + 1 if previous else 1
        series[slot][day] = reading

    def mean(slot: str, key: str) -> int | None:
        values = [item[key] for item_slot, _, item in readings if item_slot == slot]
        return round(statistics.fmean(values)) if values else None

    in_band = sum(1 for _, _, item in readings if item["in_band"])
    highest = max(readings, key=lambda entry: (entry[2]["sys"], entry[2]["dia"]), default=None)
    return {
        "morning": series["morning"],
        "evening": series["evening"],
        "stats": {
            "morning_count": sum(1 for slot, _, _ in readings if slot == "morning"),
            "evening_count": sum(1 for slot, _, _ in readings if slot == "evening"),
            "morning_mean": [mean("morning", "sys"), mean("morning", "dia")] if series["morning"] else None,
            "evening_mean": [mean("evening", "sys"), mean("evening", "dia")] if series["evening"] else None,
            "in_band": in_band,
            "total": len(readings),
            "highest": {
                "sys": highest[2]["sys"], "dia": highest[2]["dia"], "date": highest[1],
                "slot": "晨" if highest[0] == "morning" else "晚",
            } if highest else None,
            "days_with_readings": len(per_day_counts),
        },
    }


def _slot_label(schedule: str | None) -> str:
    text = schedule or ""
    if any(marker in text for marker in ("早", "晨", "上午")):
        return "早"
    if any(marker in text for marker in ("晚", "夜", "睡前")):
        return "晚"
    return text.strip() or "—"


def build_medications(
    plans: list[dict[str, Any]], medications: list[dict[str, Any]], keys: list[str], today: str,
) -> list[dict[str, Any]]:
    active = [plan for plan in plans if plan.get("status") == "active" and plan.get("user_confirmed")]
    rows: list[dict[str, Any]] = []
    if active:
        for plan in active:
            rows.append({
                "plan_id": plan["id"], "name": plan["medication"], "slot": _slot_label(plan.get("schedule")),
                "dose": f"{plan.get('dose') or ''} {plan.get('unit') or ''}".strip() or None,
                "dose_value": plan.get("dose"), "dose_unit": plan.get("unit"),
                "source": "plan",
            })
    else:
        names = sorted({item["medication"] for item in medications if item.get("taken_at", "")[:10] in keys})
        for name in names:
            rows.append({"plan_id": None, "name": name, "slot": "—", "dose": None, "dose_value": None, "dose_unit": None, "source": "records"})
    by_key: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in medications:
        day = (item.get("taken_at") or "")[:10]
        if day in keys:
            by_key[(item["medication"], day)].append(item)
    recent_week = [day for day in keys if day < today][-7:]
    for row in rows:
        cells: dict[str, dict[str, Any]] = {}
        for day in keys:
            records = [
                item for item in by_key.get((row["name"], day), [])
                if row["plan_id"] is None or not item.get("medication_plan_id") or item.get("medication_plan_id") == row["plan_id"]
            ]
            taken = [item for item in records if item.get("taken", True)]
            skipped = [item for item in records if not item.get("taken", True)]
            if taken:
                doses = [f"{item.get('dose') or ''}{item.get('unit') or ''}".strip() for item in taken]
                state, detail = "taken", "、".join(dose for dose in doses if dose) or "剂量未填写"
            elif skipped:
                state, detail = "skipped", "记录为未服"
            elif day == today:
                state, detail = "pending", "今日待记录"
            else:
                state, detail = "missing", "未记录"
            cells[day] = {"state": state, "detail": detail, "count": len(taken)}
        # Without a confirmed plan, a medication only counts as "expected today"
        # when it was actually recorded on most of the last seven days.
        routine_days = sum(1 for day in recent_week if cells.get(day, {}).get("state") == "taken")
        row["routine"] = row["plan_id"] is not None or (len(recent_week) >= 4 and routine_days >= 4)
        if not row["routine"] and cells.get(today, {}).get("state") == "pending":
            cells[today] = {"state": "missing", "detail": "未记录（非每日用药）", "count": 0}
        row["cells"] = cells
        row["taken_days"] = sum(1 for cell in cells.values() if cell["state"] == "taken")
    slot_order = {"早": 0, "晚": 1}
    rows.sort(key=lambda row: (slot_order.get(row["slot"], 2), row["name"]))
    return rows


def is_meditation(activity_type: str | None) -> bool:
    return any(marker in (activity_type or "") for marker in MEDITATION_MARKERS)


def build_activities(activities: list[dict[str, Any]], keys: list[str], today: date) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cutoff30 = (today - timedelta(days=29)).isoformat()
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in activities:
        if item.get("date") and item.get("activity_type"):
            grouped[item["activity_type"]].append(item)
    shown: list[dict[str, Any]] = []
    folded: list[dict[str, Any]] = []
    for name, items in grouped.items():
        recent30 = [item for item in items if item["date"] >= cutoff30 and item["date"] <= today.isoformat()]
        last_date = max(item["date"] for item in items)
        days_ago = (today - date.fromisoformat(last_date)).days
        count_total, count_unit, minutes, km, steps = 0, "", 0.0, 0.0, 0
        for item in recent30:
            counted = note_count(item.get("note"))
            if counted:
                count_total += counted[0]
                count_unit = counted[1]
            minutes += float(item.get("duration_minutes") or 0)
            km += float(item.get("distance_km") or 0)
            steps += int(item.get("steps") or 0)
        metric = "count" if count_total else ("km" if km else "minutes")
        unit = (count_unit or "个") if metric == "count" else ("km" if metric == "km" else "分")
        per_day: dict[str, float] = defaultdict(float)
        for item in items:
            if item["date"] not in keys:
                continue
            if metric == "count":
                counted = note_count(item.get("note"))
                per_day[item["date"]] += counted[0] if counted else 0
            elif metric == "km":
                per_day[item["date"]] += float(item.get("distance_km") or 0)
            else:
                per_day[item["date"]] += float(item.get("duration_minutes") or 0)
        days = {day: (round(value, 1) if metric == "km" else int(round(value))) for day, value in per_day.items()}
        totals = []
        if count_total:
            totals.append(f"累计 {count_total:,} {count_unit}")
        if minutes:
            totals.append(f"累计 {int(round(minutes))} 分钟")
        if km:
            totals.append(f"累计 {km:.1f} km")
        if steps:
            totals.append(f"累计 {steps:,} 步")
        label, cls = _days_ago_label(days_ago)
        entry = {
            "name": name, "meditation": is_meditation(name), "unit": unit, "metric": metric,
            "sessions30": len(recent30), "last_date": last_date, "last_label": label, "last_class": cls,
            "total": " · ".join(totals) + ("（近 30 天）" if totals else ""),
            "days": days,
        }
        (shown if days else folded).append(entry)
    shown.sort(key=lambda entry: (entry["meditation"], -entry["sessions30"], entry["name"]))
    folded.sort(key=lambda entry: entry["last_date"], reverse=True)
    return shown, folded


def build_sleep(records: list[dict[str, Any]], keys: list[str]) -> dict[str, Any]:
    by_day: dict[str, dict[str, Any]] = {}
    for item in sorted(records, key=lambda entry: entry.get("created_at") or ""):
        day = item.get("date")
        if day in keys and item.get("duration_minutes"):
            by_day[day] = {
                "hours": round(float(item["duration_minutes"]) / 60, 1), "quality": item.get("quality"),
                "bedtime": item.get("bedtime"), "wake_time": item.get("wake_time"),
            }
    hours = [entry["hours"] for entry in by_day.values()]
    return {
        "days": by_day,
        "stats": {
            "average": round(statistics.fmean(hours), 1) if hours else None,
            "seven_plus": sum(1 for value in hours if value >= 7),
            "recorded": len(hours),
            "missing": len(keys) - len(hours),
        },
    }


def build_emotions(records: list[dict[str, Any]], keys: list[str]) -> list[dict[str, Any]]:
    items = [item for item in records if (item.get("occurred_at") or "")[:10] in keys]
    items.sort(key=lambda entry: entry.get("occurred_at") or "", reverse=True)
    return [{
        "date": item["occurred_at"][:10], "time": item["occurred_at"][11:16], "name": item.get("name"),
        "minutes": item.get("duration_minutes"), "feelings": item.get("feelings"), "reflection": item.get("reflection"),
    } for item in items]


def field_label(field: str) -> str:
    labels = _FIELD_LABELS.get(field)
    return labels[0] if labels else field


def build_labs(observations: list[dict[str, Any]], limit: int = 12) -> list[dict[str, Any]]:
    by_field: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in observations:
        by_field[item["field"]].append(item)
    rows = []
    for field, items in by_field.items():
        items.sort(key=lambda entry: (entry["measured_at"], entry["created_at"]))
        latest, previous = items[-1], items[-2] if len(items) > 1 else None
        numeric = latest.get("value_type", "numeric") == "numeric" and latest.get("mapping_status") == "mapped"
        value = latest.get("text_value") if latest.get("value_type") == "text" else latest.get("value")
        delta = None
        if numeric and previous and previous.get("value_type", "numeric") == "numeric" and previous.get("unit") == latest.get("unit"):
            delta = round(float(latest["value"]) - float(previous["value"]), 2)
        rows.append({
            "field": field, "label": field_label(field), "value": value, "unit": latest.get("unit"),
            "raw_unit": latest.get("raw_unit"), "mapping_status": latest.get("mapping_status"),
            "date": latest["measured_at"][:10], "observation_id": latest["id"],
            "previous": (previous.get("text_value") if previous.get("value_type") == "text" else previous.get("value")) if previous else None,
            "previous_date": previous["measured_at"][:10] if previous else None,
            "delta": delta, "count": len(items),
        })
    rows.sort(key=lambda row: (row["date"], row["label"]), reverse=True)
    return rows[:limit]


def build_pending(
    jobs: dict[str, dict[str, Any]], candidates: dict[str, dict[str, Any]], person_id: str,
    store_documents: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    store_documents = store_documents or {}
    pending_jobs = []
    for job in jobs.values():
        if job.get("status") not in ("awaiting_review", "awaiting_identity"):
            continue
        if job.get("person_id") not in (person_id, None):
            continue
        open_candidates = [candidates[cid] for cid in job.get("candidate_ids", []) if cid in candidates and candidates[cid].get("status") == "candidate"]
        if not open_candidates:
            continue
        document = store_documents.get(job.get("document_id"), {})
        pending_jobs.append({
            "job_id": job["id"], "status": job["status"], "created_at": (job.get("created_at") or "")[:10],
            "filename": document.get("filename"), "report_date": document.get("report_date"),
            "candidates": len(open_candidates),
            "unmapped": sum(1 for item in open_candidates if item.get("mapping_status") != "mapped"),
            "needs_identity": job.get("status") == "awaiting_identity",
        })
    pending_jobs.sort(key=lambda job: job["created_at"], reverse=True)
    return {
        "jobs": pending_jobs,
        "candidates": sum(job["candidates"] for job in pending_jobs),
        "unmapped": sum(job["unmapped"] for job in pending_jobs),
        "needs_identity": sum(1 for job in pending_jobs if job["needs_identity"]),
    }


def build_encounters(encounters: list[dict[str, Any]], diagnoses: list[dict[str, Any]], limit: int = 6) -> list[dict[str, Any]]:
    type_labels = {"outpatient": "门诊", "inpatient": "住院", "emergency": "急诊", "checkup": "体检", "telehealth": "线上问诊", "other": "就诊"}
    rows = []
    for item in sorted(encounters, key=lambda entry: entry.get("occurred_on") or "", reverse=True)[:limit]:
        mentions = [
            {"text": mention["text"], "context": CONTEXT_LABELS.get(mention.get("context"), mention.get("context"))}
            for mention in diagnoses
            if mention.get("encounter_id") == item["id"] or (not mention.get("encounter_id") and mention.get("occurred_on") == item.get("occurred_on"))
        ]
        rows.append({
            "date": item.get("occurred_on"), "type": type_labels.get(item.get("encounter_type"), "就诊"),
            "facility": item.get("facility"), "department": item.get("department"), "note": item.get("note"),
            "documents": len(item.get("document_ids") or []), "mentions": mentions,
        })
    return rows


def build_goals(
    goals: list[dict[str, Any]], *, today: date, vitals: list[dict[str, Any]], medications: list[dict[str, Any]],
    plans: list[dict[str, Any]], activities: list[dict[str, Any]], sleep: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    keys = day_keys(today, 30)
    bp_days: dict[str, set[str]] = defaultdict(set)
    for vital in vitals:
        day = (vital.get("measured_at") or "")[:10]
        if day in keys and vital.get("systolic_mmHg") is not None:
            bp_days[day].add(bp_slot(vital))
    med_days: dict[str, set[str]] = defaultdict(set)
    for item in medications:
        day = (item.get("taken_at") or "")[:10]
        if day in keys and item.get("taken", True):
            med_days[day].add(item["medication"])
    active_meds = {plan["medication"] for plan in plans if plan.get("status") == "active" and plan.get("user_confirmed")}
    exercise_days: set[str] = set()
    meditation_minutes: dict[str, float] = defaultdict(float)
    for item in activities:
        day = item.get("date")
        if day not in keys:
            continue
        if is_meditation(item.get("activity_type")):
            meditation_minutes[day] += float(item.get("duration_minutes") or 0)
        else:
            exercise_days.add(day)
    sleep_hours: dict[str, float] = {}
    for item in sleep:
        if item.get("date") in keys and item.get("duration_minutes"):
            sleep_hours[item["date"]] = float(item["duration_minutes"]) / 60
    rows = []
    for goal in goals:
        kind = goal["kind"]
        threshold = goal.get("threshold")
        if kind == "bp_twice":
            achieved, of = sum(1 for day in keys if {"morning", "evening"} <= bp_days.get(day, set())), len(keys)
        elif kind == "medication_recorded":
            if active_meds:
                achieved = sum(1 for day in keys if active_meds <= med_days.get(day, set()))
            else:
                achieved = sum(1 for day in keys if med_days.get(day))
            of = len(keys)
        elif kind == "exercise_daily":
            achieved, of = len(exercise_days), len(keys)
        elif kind == "sleep_hours":
            achieved, of = sum(1 for value in sleep_hours.values() if value >= float(threshold)), len(sleep_hours)
        else:  # meditation_minutes
            achieved, of = sum(1 for value in meditation_minutes.values() if value >= float(threshold)), len(keys)
        rows.append({
            "id": goal["id"], "title": goal["title"], "note": goal.get("note") or "", "kind": kind,
            "achieved": achieved, "of": of, "percent": round(achieved / of * 100) if of else None,
        })
    return rows


def build_today(
    *, today: str, bp: dict[str, Any], meds: list[dict[str, Any]], activities: list[dict[str, Any]],
    sleep: dict[str, Any], raw_activities: list[dict[str, Any]], band: dict[str, list[int]], goals: list[dict[str, Any]],
) -> dict[str, Any]:
    tiles: list[dict[str, Any]] = []
    missing: list[str] = []

    def band_status(reading: dict[str, Any]) -> dict[str, str]:
        return {"cls": "good", "text": "区间内"} if reading["in_band"] else {"cls": "warn", "text": "区间外"}

    for slot, label in (("morning", "晨间血压"), ("evening", "晚间血压")):
        reading = bp[slot].get(today)
        if reading:
            tiles.append({"label": label, "value": f"{reading['sys']}/{reading['dia']}", "unit": "mmHg", "status": band_status(reading), "time": reading["time"]})
        else:
            tiles.append({"label": label, "value": "未记录", "empty": True, "status": {"cls": "none", "text": "待记录"}, "time": ""})
            missing.append(label)
    routine = [row for row in meds if row.get("routine")]
    if routine:
        recorded = sum(1 for row in routine if row["cells"].get(today, {}).get("state") == "taken")
        pending_rows = [row for row in routine if row["cells"].get(today, {}).get("state") in ("pending", "missing")]
        slot_names = {"早": "早间", "晚": "晚间"}
        status = {"cls": "good", "text": "已全部记录"} if not pending_rows else {"cls": "warn", "text": "、".join(slot_names.get(row["slot"], row["name"]) for row in pending_rows) + "待记录"}
        tiles.append({"label": "用药", "value": str(recorded), "unit": f"/ {len(routine)} 项已记录", "status": status, "time": ""})
        if pending_rows:
            missing.append("用药：" + "、".join(row["name"] for row in pending_rows))
    elif meds:
        recorded = sum(1 for row in meds if row["cells"].get(today, {}).get("state") == "taken")
        tiles.append({"label": "用药", "value": str(recorded), "unit": "项已记录", "status": {"cls": "none", "text": "无每日计划"}, "time": ""})
    else:
        tiles.append({"label": "用药", "value": "无计划", "empty": True, "status": {"cls": "none", "text": "未设置用药计划"}, "time": ""})
    today_acts = [item for item in raw_activities if item.get("date") == today]
    exercise = [item for item in today_acts if not is_meditation(item.get("activity_type"))]
    meditation = sum(float(item.get("duration_minutes") or 0) for item in today_acts if is_meditation(item.get("activity_type")))
    if exercise:
        first = exercise[0]
        counted = note_count(first.get("note"))
        detail = f"{counted[0]} {counted[1]}" if counted else (f"{int(first['duration_minutes'])} 分钟" if first.get("duration_minutes") else "")
        tiles.append({"label": "运动", "value": first["activity_type"], "unit": detail, "status": {"cls": "good", "text": "有记录"}, "time": f"{len(exercise)} 项" if len(exercise) > 1 else ""})
    else:
        tiles.append({"label": "运动", "value": "未记录", "empty": True, "status": {"cls": "none", "text": "未开始"}, "time": ""})
        missing.append("运动")
    meditation_goal = next((goal for goal in goals if goal["kind"] == "meditation_minutes"), None)
    target = meditation_goal.get("threshold") if meditation_goal else None
    if meditation:
        ok = target is None or meditation >= float(target)
        tiles.append({"label": "冥想", "value": str(int(meditation)), "unit": "分钟", "status": {"cls": "good" if ok else "warn", "text": "已达标" if ok else f"目标 {int(target)} 分钟"}, "time": ""})
    else:
        tiles.append({"label": "冥想", "value": "0", "unit": "分钟", "empty": True, "status": {"cls": "none", "text": "未开始"}, "time": f"目标 {int(target)} 分钟" if target else ""})
        missing.append(f"冥想{f' {int(target)} 分钟' if target else ''}")
    last_night = sleep["days"].get(today)
    if last_night:
        ok = last_night["hours"] >= 7
        time_text = f"{last_night['bedtime']} – {last_night['wake_time']}" if last_night.get("bedtime") and last_night.get("wake_time") else ""
        if last_night.get("quality"):
            time_text = f"{time_text} · 质量 {last_night['quality']}".strip(" ·")
        tiles.append({"label": "昨夜睡眠", "value": f"{last_night['hours']}", "unit": "小时", "status": {"cls": "good" if ok else "warn", "text": "≥ 7 小时" if ok else "不足 7 小时"}, "time": time_text})
    else:
        tiles.append({"label": "昨夜睡眠", "value": "未记录", "empty": True, "status": {"cls": "none", "text": "待记录"}, "time": ""})
        missing.append("昨夜睡眠")
    return {"tiles": tiles, "missing": missing}


def latest_record(store_state: dict[str, Any], person_id: str) -> dict[str, str] | None:
    """The most recent event the user recorded, by the event's own timestamp."""
    sources = {
        "vitals": ("血压/体重", "measured_at"), "medications": ("服药", "taken_at"), "activities": ("运动", "date"),
        "emotions": ("情绪", "occurred_at"), "sleep_records": ("睡眠", "date"), "observations": ("检验", "measured_at"),
    }
    best: tuple[str, str] | None = None
    for collection, (label, key) in sources.items():
        for item in store_state.get(collection, {}).values():
            if item.get("person_id") != person_id:
                continue
            stamp = str(item.get(key) or "")
            if stamp and (best is None or stamp > best[0]):
                best = (stamp, label)
    return {"at": best[0][:16].replace("T", " "), "type": best[1]} if best else None


def build_model(
    store: Any, person_id: str, *, settings: dict[str, Any], today: date, days: int, mode: str,
    generated_at: datetime, vault_label: str,
) -> dict[str, Any]:
    keys = day_keys(today, days)
    band = settings["bp_target"]
    person = store.state["persons"].get(person_id) or {}
    vitals = store.vitals(person_id, limit=5000)
    medications = store.medications(person_id, limit=5000)
    plans = store.medication_plans(person_id)
    activities = store.activities(person_id, limit=5000)
    emotions = store.emotions(person_id, limit=5000)
    sleep_records = store.sleep_records(person_id, limit=5000)
    observations = store.observations(person_id)
    bp = build_bp(vitals, keys, band)
    meds = build_medications(plans, medications, keys, today.isoformat())
    shown, folded = build_activities(activities, keys, today)
    sleep = build_sleep(sleep_records, keys)
    goals = build_goals(settings["goals"], today=today, vitals=vitals, medications=medications, plans=plans, activities=activities, sleep=sleep_records)
    today_block = build_today(today=today.isoformat(), bp=bp, meds=meds, activities=shown, sleep=sleep, raw_activities=activities, band=band, goals=settings["goals"])
    return {
        "mode": mode,
        "generated_at": generated_at.strftime("%Y-%m-%d %H:%M"),
        "today": today.isoformat(),
        "today_label": f"{today.year} 年 {today.month} 月 {today.day} 日 · {WEEKDAYS[today.weekday()]}",
        "person": {"id": person_id, "display_name": person.get("display_name") or settings.get("display_name") or person_id},
        "range": {"days": days, "start": keys[0], "end": keys[-1]},
        "days": keys,
        "vault_label": vault_label,
        "last_record": latest_record(store.state, person_id),
        "bp_target": band,
        "today_block": today_block,
        "bp": bp,
        "medications": meds,
        "activities": shown,
        "other_activities": folded,
        "sleep": sleep,
        "emotions": build_emotions(emotions, keys),
        "labs": build_labs(observations),
        "pending": build_pending(store.state.get("jobs", {}), store.state.get("candidates", {}), person_id, store.state.get("documents", {})),
        "encounters": build_encounters(store.encounters(person_id), store.diagnoses(person_id)),
        "goals": goals,
    }
