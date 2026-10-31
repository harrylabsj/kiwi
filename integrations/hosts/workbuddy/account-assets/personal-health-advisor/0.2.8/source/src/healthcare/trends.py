"""Deterministic personal-health trend calculations.

This module intentionally returns measurements and calculation limits, not
clinical interpretation. Language models may summarize this output but never
invent points, reference ranges, or causal explanations.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date
from typing import Any


def _date_in_range(value: str, start: str | None, end: str | None) -> bool:
    current = date.fromisoformat(value[:10]).isoformat()
    return (start is None or current >= start) and (end is None or current <= end)


def summarize_points(
    points: list[dict[str, Any]], *, source: str, field: str, unit: str | None,
    excluded: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Return transparent descriptive statistics for already comparable points."""
    excluded = excluded or []
    values = [point["value"] for point in points]
    days = sorted({point["date"] for point in points})
    result: dict[str, Any] = {
        "source": source,
        "field": field,
        "unit": unit,
        "points": points,
        "point_count": len(points),
        "coverage_days": len(days),
        "date_range": {"start": days[0] if days else None, "end": days[-1] if days else None},
        "excluded": excluded,
        "summary": None,
        "warnings": [],
    }
    if not points:
        result["warnings"].append("没有可比较的已确认记录。")
        return result
    summary: dict[str, float | None] = {
        "minimum": min(values),
        "maximum": max(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "change_from_first_to_last": values[-1] - values[0] if len(values) > 1 else None,
    }
    result["summary"] = summary
    if len(points) < 2:
        result["warnings"].append("只有一个可比较的数据点，不能判断变化趋势。")
    if excluded:
        result["warnings"].append("部分记录因单位、比较符或数据类型不可比而未纳入计算。")
    return result


def observation_trend(
    observations: list[dict[str, Any]], field: str, start: str | None = None, end: str | None = None,
) -> dict[str, Any]:
    comparable: list[dict[str, Any]] = []
    excluded: list[dict[str, str]] = []
    units: set[str | None] = set()
    for item in observations:
        if item.get("field") != field or not _date_in_range(item["measured_at"], start, end):
            continue
        if item.get("value_type", "numeric") != "numeric" or item.get("raw_comparator"):
            excluded.append({"id": item["id"], "reason": "定性结果或带比较符的数值不能按精确数值聚合"})
            continue
        if item.get("mapping_status") != "mapped":
            excluded.append({"id": item["id"], "reason": "单位未映射"})
            continue
        units.add(item.get("unit"))
        comparable.append({"id": item["id"], "date": item["measured_at"], "value": float(item["value"]), "evidence_id": item["evidence_id"]})
    if len(units) > 1:
        return summarize_points([], source="observation", field=field, unit=None, excluded=excluded + [
            {"id": "series", "reason": "同一指标存在多个单位，不能自动合并"},
        ])
    comparable.sort(key=lambda item: (item["date"], item["id"]))
    return summarize_points(comparable, source="observation", field=field, unit=next(iter(units), None), excluded=excluded)


def vital_trend(
    vitals: list[dict[str, Any]], field: str, start: str | None = None, end: str | None = None,
) -> dict[str, Any]:
    allowed = {
        "systolic_mmHg": "mmHg", "diastolic_mmHg": "mmHg", "heart_rate_bpm": "bpm", "weight_kg": "kg",
    }
    if field not in allowed:
        raise ValueError("unsupported vital trend field")
    raw: list[dict[str, Any]] = []
    for item in vitals:
        value = item.get(field)
        if value is None or not _date_in_range(item["measured_at"], start, end):
            continue
        raw.append({"id": item["id"], "date": item["measured_at"][:10], "value": float(value)})
    raw.sort(key=lambda item: (item["date"], item["id"]))
    # Preserve every reading and additionally provide an explicit daily mean.
    by_day: dict[str, list[float]] = defaultdict(list)
    for item in raw:
        by_day[item["date"]].append(item["value"])
    result = summarize_points(raw, source="vital", field=field, unit=allowed[field])
    result["daily_means"] = [
        {"date": day, "value": statistics.fmean(values), "sample_count": len(values)}
        for day, values in sorted(by_day.items())
    ]
    return result
