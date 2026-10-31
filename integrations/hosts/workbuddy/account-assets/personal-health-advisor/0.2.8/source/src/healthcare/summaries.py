"""Source-linked visit summary assembly without diagnostic inference."""

from __future__ import annotations

from datetime import date
from typing import Any


def _in_range(value: str | None, start: str | None, end: str | None) -> bool:
    if not value:
        return False
    current = date.fromisoformat(value[:10]).isoformat()
    return (start is None or current >= start) and (end is None or current <= end)


def build_visit_summary(store: Any, person_id: str, start: str | None = None, end: str | None = None) -> dict[str, Any]:
    """Build an inspectable draft; the caller decides whether and how to export it."""
    observations = [item for item in store.observations(person_id) if _in_range(item.get("measured_at"), start, end)]
    encounters = [item for item in store.encounters(person_id) if _in_range(item.get("occurred_on"), start, end)]
    diagnoses = [item for item in store.diagnoses(person_id) if not item.get("occurred_on") or _in_range(item.get("occurred_on"), start, end)]
    medications = [item for item in store.medications(person_id, limit=5000) if _in_range(item.get("taken_at"), start, end)]
    activities = [item for item in store.activities(person_id, limit=5000) if _in_range(item.get("date"), start, end)]
    return {
        "person_id": person_id,
        "date_range": {"start": start, "end": end},
        "encounters": encounters,
        "diagnosis_mentions": diagnoses,
        "medication_plans": store.medication_plans(person_id),
        "medication_intake_events": medications,
        "confirmed_observations": observations,
        "activity_records": activities,
        "limitations": [
            "本摘要仅整理已保存的个人记录和原文诊断提及，不构成诊断或治疗建议。",
            "未带来源或日期不明的资料可能未包含在所选时间范围内。",
        ],
    }


def render_visit_summary_markdown(summary: dict[str, Any]) -> str:
    """Render a user-reviewable export without adding clinical interpretation."""
    period = summary["date_range"]
    lines = [
        "# 就医资料摘要（草稿）",
        "",
        f"- 人物：{summary['person_id']}",
        f"- 时间范围：{period['start'] or '未限制'} 至 {period['end'] or '未限制'}",
        "",
        "## 就诊记录",
    ]
    for item in summary["encounters"]:
        parts = [item["occurred_on"], item.get("facility") or "未填写机构", item.get("department") or ""]
        lines.append(f"- {'｜'.join(part for part in parts if part)}")
    if not summary["encounters"]:
        lines.append("- 无记录")
    lines.extend(["", "## 诊断原文提及"])
    for item in summary["diagnosis_mentions"]:
        lines.append(f"- {item.get('occurred_on') or '日期未填写'}｜{item['context']}｜{item['text']}")
    if not summary["diagnosis_mentions"]:
        lines.append("- 无记录")
    lines.extend(["", "## 已确认用药计划"])
    for item in summary["medication_plans"]:
        if item.get("status") == "active" and item.get("user_confirmed"):
            dose = f" {item['dose']}{item.get('unit') or ''}" if item.get("dose") else ""
            lines.append(f"- {item['medication']}{dose}｜{item['schedule']}")
    if not any(item.get("status") == "active" and item.get("user_confirmed") for item in summary["medication_plans"]):
        lines.append("- 无已确认的有效计划")
    lines.extend(["", "## 实际用药记录"])
    for item in summary["medication_intake_events"]:
        state = "已记录服用" if item.get("taken") else "已记录未服"
        lines.append(f"- {item['taken_at']}｜{item['medication']}｜{state}")
    if not summary["medication_intake_events"]:
        lines.append("- 无记录")
    lines.extend(["", "## 已确认检验/测量观察"])
    for item in summary["confirmed_observations"]:
        value = item.get("text_value") or f"{item['value']} {item.get('unit') or ''}".strip()
        lines.append(f"- {item['measured_at']}｜{item['field']}｜{value}｜证据 {item['evidence_id']}")
    if not summary["confirmed_observations"]:
        lines.append("- 无记录")
    lines.extend(["", "## 使用限制"])
    lines.extend(f"- {item}" for item in summary["limitations"])
    return "\n".join(lines) + "\n"
