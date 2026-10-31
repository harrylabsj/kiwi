"""Fictional demo Vault for previews, inspiration cases and tests.

The demo person "林禾（示例）" and every value here are invented. The Vault is
rebuilt whenever its anchor date changes so "today" stays today; it never
touches the personal Vault and uses a constant, non-secret passphrase.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

from ..control import ControlSession
from ..vault import VaultStore
from .auth import DEMO_PASSPHRASE
from .paths import demo_marker_path, demo_vault_path, write_private_text

DEMO_PERSON = "demo"
DEMO_DISPLAY_NAME = "林禾（示例）"
DEMO_VERSION = 1

# (days before today, systolic, diastolic, time) — None = no reading that slot.
_MORNING = [
    (13, 124, 82, "06:58"), (12, 119, 77, "07:05"), (11, 127, 84, "06:50"), (10, 116, 75, "07:10"),
    (9, 121, 79, "07:02"), (8, 113, 72, "07:30"), (7, 118, 76, "07:15"), (6, 131, 86, "06:45"),
    (5, 122, 78, "07:00"), (3, 117, 74, "07:08"), (2, 120, 78, "07:20"), (1, 115, 74, "07:40"),
    (0, 118, 76, "07:12"),
]
_EVENING = [
    (13, 121, 78, "21:40"), (12, 118, 76, "21:30"), (11, 122, 79, "22:05"), (9, 117, 74, "21:50"),
    (8, 115, 73, "21:20"), (7, 119, 77, "21:45"), (6, 124, 80, "22:10"), (5, 118, 75, "21:35"),
    (4, 120, 77, "21:55"), (3, 116, 73, "21:30"), (2, 119, 76, "21:40"), (1, 117, 75, "21:25"),
]
_PUSHUPS = {29: 48, 27: 52, 26: 50, 24: 55, 22: 50, 21: 51, 19: 50, 18: 53, 16: 60, 15: 58, 13: 50, 12: 51, 11: 50, 10: 50, 7: 57, 6: 70, 2: 80, 0: 60}
_WALKS = {25: (3.0, 35), 20: (3.8, 42), 17: (2.9, 33), 14: (3.4, 40), 11: (3.2, 38), 8: (4.1, 45), 5: (2.8, 30), 1: (3.5, 40)}
_MEDITATION = {23: 10, 19: 8, 16: 10, 12: 8, 7: 8, 3: 10}
_SQUATS = {23: 50}
_RUNS = {22: (3.0, 18)}
_SLEEP = {
    13: (6.8, 3, "23:40", "06:28"), 12: (7.3, 4, "23:10", "06:28"), 11: (6.1, 3, "00:20", "06:26"), 10: (7.6, 4, "22:50", "06:26"),
    9: (7.1, 4, "23:20", "06:26"), 8: (7.9, 5, "22:40", "06:34"), 7: (6.5, 3, "23:50", "06:20"), 6: (5.9, 2, "00:40", "06:34"),
    5: (7.2, 4, "23:10", "06:22"), 3: (7.4, 4, "23:00", "06:24"), 2: (6.9, 4, "23:30", "06:24"), 1: (7.8, 5, "22:40", "06:28"),
    0: (7.0, 4, "23:20", "06:20"),
}
_EMOTIONS = [
    (1, "15:40", "疲惫", 40, "下午开会后眼睛发涩，不想说话", "提前把明天的第一件事写好，晚上不再开电脑"),
    (3, "08:30", "平静", None, "晨走回来坐了十分钟，什么都没想", None),
    (6, "07:10", "烦躁", 15, "早上血压偏高，看数字时心里发紧", "先照常吃药、照常走路，晚上再测一次"),
    (11, "09:30", "紧张", 25, "胸口发紧，注意力变窄", "先把下一步写下来会更踏实"),
]


def _report(report_date: str, creatinine: str, ua: str, hemoglobin: str, potassium: str, egfr: str) -> str:
    return (
        "检验报告（示例）\n"
        f"报告日期：{report_date}\n"
        f"血肌酐 {creatinine} umol/L\n"
        f"血清尿酸 {ua} umol/L\n"
        f"血红蛋白 {hemoglobin} g/dL\n"
        f"血钾 {potassium} mmol/L\n"
        f"eGFR {egfr} mL/min/1.73m²\n"
    )


def build_demo_vault(path: Path, today: date) -> VaultStore:
    """Build (or rebuild in place) the fictional demo Vault.

    Nothing is deleted: an existing demo Vault is overwritten through the same
    atomic save every Vault uses, and stale encrypted objects from a previous
    build are simply left unreferenced. (WorkBuddy's sandbox and the product
    rule "never delete user files" both apply here.)
    """
    if path.exists():
        store = VaultStore(path, DEMO_PASSPHRASE, VaultStore.fresh_state())
        store._persisted_revision = store._on_disk_revision() or 0
        store.save()
    else:
        store = VaultStore.create(path, DEMO_PASSPHRASE)
    day = lambda offset: (today - timedelta(days=offset)).isoformat()  # noqa: E731
    with store.deferred_save():
        store.ensure_person(DEMO_PERSON, DEMO_DISPLAY_NAME)
        for offset, sys_v, dia_v, at in _MORNING:
            store.record_vital(DEMO_PERSON, f"{day(offset)}T{at}", sys_v, dia_v, 68, context={"period": "晨间"})
        for offset, sys_v, dia_v, at in _EVENING:
            store.record_vital(DEMO_PERSON, f"{day(offset)}T{at}", sys_v, dia_v, 66, context={"period": "晚间"})
        morning_plan = store.create_medication_plan(
            DEMO_PERSON, "降压药（示例）", "每天早上 08:00", dose="0.5", unit="片", status="active", user_confirmed=True,
        )
        evening_plan = store.create_medication_plan(
            DEMO_PERSON, "调脂药（示例）", "每天晚上 21:00", dose="1", unit="片", status="active", user_confirmed=True,
        )
        for offset in range(29, -1, -1):
            if offset != 4:
                store.record_medication(DEMO_PERSON, f"{day(offset)}T07:20", "降压药（示例）", "0.5", "片", medication_plan_id=morning_plan.id)
            if offset == 10:
                store.record_medication(DEMO_PERSON, f"{day(offset)}T21:10", "调脂药（示例）", "1", "片", taken=False, note="出差忘带", medication_plan_id=evening_plan.id)
            elif offset not in (4, 0):
                store.record_medication(DEMO_PERSON, f"{day(offset)}T21:10", "调脂药（示例）", "1", "片", medication_plan_id=evening_plan.id)
        for offset, count in _PUSHUPS.items():
            store.record_activity(DEMO_PERSON, day(offset), "俯卧撑", 6, note=f"共 {count} 个")
        for offset, (km, minutes) in _WALKS.items():
            store.record_activity(DEMO_PERSON, day(offset), "快走", minutes, km)
        for offset, minutes in _MEDITATION.items():
            store.record_activity(DEMO_PERSON, day(offset), "冥想", minutes)
        for offset, count in _SQUATS.items():
            store.record_activity(DEMO_PERSON, day(offset), "深蹲", 5, note=f"共 {count} 个")
        for offset, (km, minutes) in _RUNS.items():
            store.record_activity(DEMO_PERSON, day(offset), "跑步", minutes, km)
        for offset, (hours, quality, bedtime, wake) in _SLEEP.items():
            store.record_sleep(DEMO_PERSON, day(offset), duration_minutes=round(hours * 60), bedtime=bedtime, wake_time=wake, quality=quality)
        for offset, at, name, minutes, feelings, reflection in _EMOTIONS:
            store.record_emotion(DEMO_PERSON, f"{day(offset)}T{at}", name, duration_minutes=minutes, feelings=feelings, reflection=reflection)
        visit = store.create_encounter(DEMO_PERSON, day(25), facility="示例医院", department="肾内科", encounter_type="outpatient", note="复诊，带上了近三个月的血压记录")
        store.record_diagnosis_mention(DEMO_PERSON, "高血压", "history", occurred_on=day(25), encounter_id=visit.id)
        store.create_encounter(DEMO_PERSON, day(122), facility="示例体检中心", encounter_type="checkup")
        control = ControlSession(store)
        for report_date, values in ((day(122), ("92", "431", "14.6", "4.3", "70")), (day(25), ("88", "402", "14.8", "4.5", "72"))):
            job = store.import_text(DEMO_PERSON, f"示例检验报告-{report_date}.txt", _report(report_date, *values), report_date)
            control.review_job(job.id, accept_all=True)
        # One report still waiting for the user's field-by-field confirmation,
        # including a unit that does not match the canonical unit (g/L vs g/dL).
        pending = (
            "检验报告（示例）\n"
            f"报告日期：{day(2)}\n"
            "空腹血糖 5.4 mmol/L\n"
            "血肌酐 86 umol/L\n"
            "血红蛋白 148 g/L\n"
        )
        store.import_text(DEMO_PERSON, f"示例检验报告-{day(2)}.txt", pending, day(2))
    return store


def ensure_demo_vault(today: date) -> Path:
    """Create or refresh the demo Vault so its dates stay anchored to today."""
    path = demo_vault_path()
    marker = demo_marker_path()
    try:
        current = json.loads(marker.read_text(encoding="utf-8")) if marker.exists() else {}
    except (OSError, json.JSONDecodeError):
        current = {}
    if path.exists() and current.get("anchor") == today.isoformat() and current.get("version") == DEMO_VERSION:
        return path
    build_demo_vault(path, today)
    write_private_text(marker, json.dumps({"anchor": today.isoformat(), "version": DEMO_VERSION}) + "\n")
    return path
