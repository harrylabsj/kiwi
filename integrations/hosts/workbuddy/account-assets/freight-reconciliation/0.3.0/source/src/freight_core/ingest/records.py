"""模板行 → 领域记录的归一化（§5.2/§6.2）。

- 每条归一化记录保留 raw 值、定位（asset_id + 原行号）与解析状态。
- ID 损坏检测：科学计数法、小数点、空关键 ID → ID_DAMAGED / PARSE_FAILED。
- 时间一律要求带时区；金额走严格十进制或整数分。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..domain import CHARGE_BASE
from ..errors import InvalidInput
from ..money import bounded_int, instant, yuan_to_minor

DAMAGED_ID_CHARS = (".", "e", "E")


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    v = value.strip()
    return v if v != "" else None


def _require(row: dict, key: str, locator: str) -> str:
    v = _clean(row.get(key))
    if v is None:
        raise InvalidInput(f"missing required field {key} at {locator}")
    return v


def _check_id(value: str, field_name: str, locator: str) -> str:
    """ID 保留前导零；科学计数法/浮点形态视为损坏（不可逆信息丢失）。"""
    lowered = value.lower()
    if ("e+" in lowered or "e-" in lowered) and any(c.isdigit() for c in lowered):
        raise InvalidInput(f"ID_DAMAGED scientific notation in {field_name} at {locator}")
    if "." in value:
        raise InvalidInput(f"ID_DAMAGED decimal point in {field_name} at {locator}")
    return value


def _amount_minor(row: dict, key: str, locator: str, unit: str) -> int:
    raw = _clean(row.get(key))
    if raw is None:
        raise InvalidInput(f"missing {key} at {locator}")
    if unit == "yuan":
        return yuan_to_minor(raw)
    try:
        return bounded_int(int(raw))
    except (ValueError, InvalidInput) as exc:
        raise InvalidInput(f"PARSE_FAILED {key}={raw!r} at {locator}") from exc


def _opt_int(row: dict, key: str, locator: str) -> int | None:
    v = _clean(row.get(key))
    if v is None:
        return None
    try:
        return bounded_int(int(v))
    except (ValueError, InvalidInput) as exc:
        raise InvalidInput(f"PARSE_FAILED {key}={v!r} at {locator}") from exc


@dataclass
class ParsedRecord:
    kind: str
    row_number: int
    payload: dict = field(default_factory=dict)
    error: str | None = None


def parse_trips_row(row: dict, row_number: int, unit: str = "minor") -> dict:
    locator = f"row={row_number}"
    trip_id = _check_id(_require(row, "trip_id", locator), "trip_id", locator)
    departed = _require(row, "departed_at", locator)
    instant(departed)  # 校验带时区
    order_ids = [o for o in (x.strip() for x in (_clean(row.get("order_ids")) or "").replace(";", ",").split(",")) if o]
    return {
        "trip_id": trip_id,
        "carrier_id": _require(row, "carrier_id", locator),
        "route_id": _require(row, "route_id", locator),
        "vehicle_class": _require(row, "vehicle_class", locator),
        "service_leg_id": _require(row, "service_leg_id", locator),
        "departed_at": departed,
        "execution_status": _require(row, "execution_status", locator),
        "order_ids": order_ids,
        "row_number": row_number,
    }


def parse_bill_row(row: dict, row_number: int, unit: str = "minor") -> dict:
    locator = f"row={row_number}"
    line_id = _check_id(_require(row, "line_id", locator), "line_id", locator)
    amount = _amount_minor(row, "amount_minor", locator, unit)
    charge_code = _require(row, "charge_code", locator).upper()
    occurrence = _clean(row.get("occurrence_id"))
    if charge_code == CHARGE_BASE:
        occurrence = occurrence or "BASE"
    if not occurrence:
        raise InvalidInput(f"missing occurrence_id for {charge_code} at {locator}")
    reversal_of = _clean(row.get("reversal_of"))
    if reversal_of is not None:
        _check_id(reversal_of, "reversal_of", locator)
    trip_ref = _clean(row.get("trip_ref"))
    if trip_ref is not None:
        trip_ref = _check_id(trip_ref, "trip_ref", locator)
    return {
        "line_id": line_id,
        "carrier_id": _require(row, "carrier_id", locator),
        "trip_ref": trip_ref,
        "service_leg_id": _clean(row.get("service_leg_id")),
        "charge_code": charge_code,
        "occurrence_id": occurrence,
        "amount_minor": amount,
        "currency": _require(row, "currency", locator).upper(),
        "amount_basis": _require(row, "amount_basis", locator).upper(),
        "reversal_of": reversal_of,
        "row_number": row_number,
    }


def parse_rates_row(row: dict, row_number: int, unit: str = "minor") -> dict:
    locator = f"row={row_number}"
    eff_from = _require(row, "effective_from", locator)
    eff_to = _require(row, "effective_to", locator)
    f, t = instant(eff_from), instant(eff_to)
    if t <= f:
        raise InvalidInput(f"empty or reversed rule interval at {locator}")
    rate = _amount_minor(row, "rate_minor", locator, unit)
    source_ref = _clean(row.get("source_ref")) or f"row={row_number}"
    return {
        "rule_id": _require(row, "rule_id", locator),
        "version": _opt_int(row, "version", locator) or 1,
        "carrier_id": _require(row, "carrier_id", locator),
        "route_id": _require(row, "route_id", locator),
        "vehicle_class": _require(row, "vehicle_class", locator),
        "charge_code": _require(row, "charge_code", locator).upper(),
        "currency": _require(row, "currency", locator).upper(),
        "amount_basis": _require(row, "amount_basis", locator).upper(),
        "effective_from": eff_from,
        "effective_to": eff_to,
        "formula": _require(row, "formula", locator),
        "rate_minor": rate,
        "free_seconds": _opt_int(row, "free_seconds", locator) or 0,
        "block_seconds": _opt_int(row, "block_seconds", locator) or 1,
        "cap_minor": _opt_int(row, "cap_minor", locator),
        "source_refs": [source_ref],
        "row_number": row_number,
    }


def parse_waiting_row(row: dict, row_number: int, unit: str = "minor") -> dict:
    locator = f"row={row_number}"
    occurrence = _require(row, "occurrence_id", locator)
    trip_id = _check_id(_require(row, "trip_id", locator), "trip_id", locator)
    arrived = _clean(row.get("arrived_at"))
    departed = _clean(row.get("departed_at"))
    verified = (_clean(row.get("verified_status")) or "").upper() == "VERIFIED"
    if arrived and departed:
        a, d = instant(arrived), instant(departed)
        elapsed = int((d - a).total_seconds())
        inverted = d < a
        verified = verified and not inverted
    elif arrived or departed:
        raise InvalidInput(f"WAIT_EVIDENCE_INVALID partial times at {locator}")
    else:
        # 已归一化形态：直接给整数秒（必须为非负整数）
        raw = _clean(row.get("elapsed_seconds"))
        if raw is None:
            raise InvalidInput(f"WAIT_EVIDENCE_INVALID no time evidence at {locator}")
        try:
            elapsed = bounded_int(int(raw), 0, 31536000)
        except (ValueError, InvalidInput) as exc:
            raise InvalidInput(f"WAIT_EVIDENCE_INVALID bad elapsed at {locator}") from exc
        inverted = False
    return {
        "occurrence_id": occurrence,
        "trip_id": trip_id,
        "elapsed_seconds": elapsed,
        "time_inverted": inverted,
        "time_evidence_verified": verified and elapsed is not None and not inverted,
        "file_ref": _clean(row.get("evidence_ref")),
        "row_number": row_number,
    }


def parse_receipt_row(row: dict, row_number: int, unit: str = "minor") -> dict:
    locator = f"row={row_number}"
    receipt_id = _check_id(_require(row, "receipt_id", locator), "receipt_id", locator)
    amount = _amount_minor(row, "amount_minor", locator, unit)
    return {
        "receipt_id": receipt_id,
        "trip_id": _check_id(_require(row, "trip_id", locator), "trip_id", locator),
        "occurrence_id": _require(row, "occurrence_id", locator),
        "amount_minor": amount,
        "currency": _require(row, "currency", locator).upper(),
        "amount_basis": _require(row, "amount_basis", locator).upper(),
        "verified_status": (_clean(row.get("verified_status")) or "").upper(),
        "file_ref": _clean(row.get("evidence_ref")),
        "row_number": row_number,
    }


def parse_pod_row(row: dict, row_number: int, unit: str = "minor") -> dict:
    locator = f"row={row_number}"
    return {
        "evidence_id": _check_id(_require(row, "evidence_id", locator), "evidence_id", locator),
        "trip_id": _check_id(_require(row, "trip_id", locator), "trip_id", locator),
        "occurrence_id": _clean(row.get("occurrence_id")),
        "evidence_type": (_require(row, "evidence_type", locator)).upper(),
        "file_ref": _clean(row.get("asset_filename")),
        "page_or_row": _clean(row.get("page_or_row")),
        "verified_status": (_clean(row.get("verified_status")) or "").upper(),
        "reviewer_ref": _clean(row.get("reviewer_ref")),
        "row_number": row_number,
    }


ROW_PARSERS = {
    "trips": (parse_trips_row, {}),
    "history_trips": (parse_trips_row, {}),
    "bill": (parse_bill_row, {}),
    "rates": (parse_rates_row, {}),
    "waiting": (parse_waiting_row, {}),
    "receipts": (parse_receipt_row, {}),
    "pod": (parse_pod_row, {}),
}
