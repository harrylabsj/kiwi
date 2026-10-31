"""整数分算术与严格导入边界。与 04_reference/reference_engine.py 语义一致并由性质测试对齐。

- 核心金额一律 int 分，绝对值 ≤ 10^12；bool/float/NaN 永不进入核心。
- 元金额只能以十进制字符串转入，最多两位小数，不用 float 乘 100。
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from .errors import InvalidInput

LIMIT = 10 ** 12
_DECIMAL_RE = re.compile(r"-?(0|[1-9][0-9]*)(\.[0-9]{1,2})?")


def bounded_int(value: Any, low: int = -LIMIT, high: int = LIMIT) -> int:
    if type(value) is not int or not low <= value <= high:
        raise InvalidInput("Expected a bounded integer, never a bool/float.")
    return value


def yuan_to_minor(text: str) -> int:
    """严格导入边界：无浮点输入、无指数、无推断舍入。"""
    if type(text) is not str or _DECIMAL_RE.fullmatch(text) is None:
        raise InvalidInput("Use an explicit decimal string with at most 2 places.")
    try:
        return bounded_int(int(Decimal(text) * 100))
    except (InvalidOperation, OverflowError, ValueError) as exc:
        raise InvalidInput("Invalid or out-of-range money.") from exc


def canonical_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                     allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def instant(text: str) -> datetime:
    """解析带时区 ISO 时间；无时区/无效即拒绝。"""
    try:
        d = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except (TypeError, ValueError, AttributeError) as exc:
        raise InvalidInput("Invalid ISO timestamp.") from exc
    if d.tzinfo is None or d.utcoffset() is None:
        raise InvalidInput("Explicit timezone required.")
    return d


def calculate_wait(elapsed: int, free: int, block: int, rate: int) -> int:
    """等候费：不足一个进位单位向上取整；先减免费秒，不先把秒截断成分/小时。"""
    e = bounded_int(elapsed, 0, 31536000)
    f = bounded_int(free, 0, 31536000)
    b = bounded_int(block, 1, 31536000)
    r = bounded_int(rate, 0)
    return bounded_int(((max(0, e - f) + b - 1) // b) * r, 0)
