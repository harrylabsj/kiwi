"""纯函数整数计价（§9）：三种首版公式，不检索网络、不执行自由代码。

语义与 04_reference/reference_engine.py 完全一致，并由性质测试双向对齐。
expected=None 表示不可比（未知），绝不用 0 伪装。
"""
from __future__ import annotations

from ..money import bounded_int, calculate_wait


def expected_per_trip(rule: dict) -> tuple[int, str]:
    """PER_TRIP：verified_trip_units 首版固定 1，不用账单自报数量放大（§9.2）。"""
    expected = bounded_int(rule["rate_minor"], 0)
    trace = f"PER_TRIP: 1 * {expected} = {expected}"
    return expected, trace


def expected_wait_blocks(rule: dict, event: dict) -> tuple[int | None, str, str | None]:
    """WAIT_BLOCKS：整数秒 + 合同块进位；时间证据缺失/倒置 → (None, '', WAIT_EVIDENCE_INVALID)。"""
    if event.get("elapsed_seconds") is None or event.get("time_evidence_verified") is not True:
        return None, "", "WAIT_EVIDENCE_INVALID"
    expected = calculate_wait(event["elapsed_seconds"], rule["free_seconds"],
                              rule["block_seconds"], rule["rate_minor"])
    trace = (f"WAIT_BLOCKS: ceil(max(0,{event['elapsed_seconds']}-{rule['free_seconds']})/"
             f"{rule['block_seconds']}) * {rule['rate_minor']} = {expected}")
    return expected, trace, None


def expected_actual_receipt(rule: dict, event: dict) -> tuple[int | None, str, str | None]:
    """ACTUAL_RECEIPT：已核验凭证金额之和，可配 cap；无有效凭证不是 0（§9.4）。"""
    if event.get("receipt_minor") is None or event.get("receipt_verified") is not True:
        return None, "", "MISSING_RECEIPT"
    receipt = bounded_int(event["receipt_minor"], 0)
    cap = rule.get("cap_minor")
    expected = receipt if cap is None else min(receipt, bounded_int(cap, 0))
    trace = f"ACTUAL_RECEIPT: receipt={receipt}, cap={cap}, expected={expected}"
    return expected, trace, None


def compute_expected(rule: dict, charge_code: str, event: dict) -> tuple[int | None, str, str | None]:
    """按规则的公式类型分派。返回 (expected_minor, trace, issue_code)。"""
    formula = rule["formula"]
    if formula == "PER_TRIP":
        expected, trace = expected_per_trip(rule)
        return expected, trace, None
    if formula == "WAIT_BLOCKS":
        return expected_wait_blocks(rule, event)
    if formula == "ACTUAL_RECEIPT":
        return expected_actual_receipt(rule, event)
    return None, "", "UNSUPPORTED_FORMULA"
