"""Parse Hermes-maintained daily health CSV exports into Vault records.

Supports the four known Hermes export shapes: blood-pressure readings,
body-weight records, medication intake events and exercise/activity sessions.
Parsing is strict about headers (a mismatch raises) and tolerant of empty cells.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

BP_HEADERS = [
    "date", "time", "period", "systolic_mmHg", "diastolic_mmHg", "heart_rate_bpm",
    "measurement_position", "medication_taken", "sleep_hours", "steps", "alcohol",
    "stress_level", "symptoms", "note",
]
MED_HEADERS = [
    "date", "time", "medication", "dose", "unit", "taken", "missed_reason",
    "side_effects", "blood_pressure_before", "blood_pressure_after", "note",
]
EXERCISE_HEADERS = [
    "date", "activity_type", "duration_minutes", "distance_km", "steps",
    "avg_heart_rate_bpm", "max_heart_rate_bpm", "intensity_1_5",
    "strength_training", "calories", "note",
]
WEIGHT_HEADERS = [
    "date", "time", "weight_kg", "height_cm", "bmi", "measurement_context", "note",
]


class CsvImportError(ValueError):
    """The CSV does not match a supported Hermes health export."""


def _read_rows(path: Path, expected_headers: list[str]) -> list[dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None or [h.strip() for h in reader.fieldnames] != expected_headers:
                raise CsvImportError(f"CSV headers do not match {path.name}")
            return [dict(row) for row in reader]
    except UnicodeDecodeError as exc:
        raise CsvImportError(f"{path.name} is not UTF-8 text") from exc


def _number(value: str | None, cast) -> Any:
    if value is None or not str(value).strip():
        return None
    try:
        return cast(str(value).strip())
    except ValueError:
        return None


def _bool_yes(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"yes", "true", "1", "y", "是", "已服"}


def _ts(date: str | None, time: str | None) -> str:
    day = (date or "").strip()
    clock = (time or "").strip()
    if day and clock:
        return f"{day}T{clock}"
    return day or clock


def parse_blood_pressure(path: Path) -> list[dict[str, Any]]:
    rows = _read_rows(path, BP_HEADERS)
    records: list[dict[str, Any]] = []
    for row in rows:
        context = {
            key: row[key].strip()
            for key in ("period", "measurement_position", "medication_taken", "sleep_hours", "steps", "alcohol", "stress_level", "symptoms")
            if row.get(key) and str(row[key]).strip()
        }
        records.append(
            {
                "measured_at": _ts(row.get("date"), row.get("time")),
                "systolic_mmHg": _number(row.get("systolic_mmHg"), int),
                "diastolic_mmHg": _number(row.get("diastolic_mmHg"), int),
                "heart_rate_bpm": _number(row.get("heart_rate_bpm"), int),
                "context": context,
                "note": (row.get("note") or "").strip() or None,
            }
        )
    return records


def parse_medication(path: Path) -> list[dict[str, Any]]:
    rows = _read_rows(path, MED_HEADERS)
    records: list[dict[str, Any]] = []
    for row in rows:
        records.append(
            {
                "taken_at": _ts(row.get("date"), row.get("time")),
                "medication": (row.get("medication") or "").strip(),
                "dose": (row.get("dose") or "").strip() or None,
                "unit": (row.get("unit") or "").strip() or None,
                "taken": _bool_yes(row.get("taken")),
                "note": (row.get("note") or "").strip() or None,
            }
        )
    return records


def parse_exercise(path: Path) -> list[dict[str, Any]]:
    rows = _read_rows(path, EXERCISE_HEADERS)
    records: list[dict[str, Any]] = []
    for row in rows:
        records.append(
            {
                "date": (row.get("date") or "").strip(),
                "activity_type": (row.get("activity_type") or "").strip(),
                "duration_minutes": _number(row.get("duration_minutes"), float),
                "distance_km": _number(row.get("distance_km"), float),
                "steps": _number(row.get("steps"), int),
                "calories": _number(row.get("calories"), int),
                "note": (row.get("note") or "").strip() or None,
            }
        )
    return records


def parse_weight(path: Path) -> list[dict[str, Any]]:
    """Parse a body-weight CSV (date,time,weight_kg,...) into vital records."""
    rows = _read_rows(path, WEIGHT_HEADERS)
    records: list[dict[str, Any]] = []
    for row in rows:
        context = {
            key: str(row[key]).strip()
            for key in ("height_cm", "bmi", "measurement_context")
            if row.get(key) and str(row[key]).strip()
        }
        records.append(
            {
                "measured_at": _ts(row.get("date"), row.get("time")),
                "weight_kg": _number(row.get("weight_kg"), float),
                "context": context,
                "note": (row.get("note") or "").strip() or None,
            }
        )
    return records
