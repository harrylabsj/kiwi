"""RFC 8785 JCS — JSON Canonicalization Scheme（KNP/1.0 §19）。

与 Kiwi TS 参考实现 `src/negotiation/jcs.ts` 逐字节一致：

- 对象键按 UTF-16 code unit 排序（本实现键全为 ASCII，code point 序 == UTF-16 序）；
- 字符串仅转义 ``"`` ``\\`` 与控制字符 U+0000–U+001F；**U+2028/U+2029 字面保留**，
  非 ASCII 不转义（不使用 ``ensure_ascii=True``）；
- 数字：整数原样；浮点最短往返形式 + 指数规范化（小写 ``e``、无 ``+``、指数无前导零）、
  ``-0`` 保留、非有限拒绝；
- 数组逗号连接；对象 ``None``（JSON null）照常序列化。

KNP envelope 中出现的数字全部是整数（amount_minor / quantity.value / count / 条件
value），整数路径精确。浮点路径对测试向量（1e21 / 1e-7 / -0）与常见取值精确；
极小/极大边界与 JS 的差异以文档注明（不影响 KNP 数据）。

零第三方依赖（纯标准库）。
"""

from __future__ import annotations

import hashlib
import math
import re
import json

__all__ = ["canonicalize", "content_digest"]


def _canonical_number(value: float | int) -> str:
    """RFC 8785 §3.2.2.2 数字序列化（镜像 JS Number#toString 的语义）。"""
    if isinstance(value, bool):
        raise TypeError("JCS: bool is not a JSON number")
    if isinstance(value, int):
        return str(value)
    # float
    if not math.isfinite(value):
        raise TypeError("JCS: cannot canonicalize non-finite number")
    if value == 0.0 and math.copysign(1.0, value) < 0:
        return "-0"
    serialized = repr(value)
    # 指数规范化：1e+21 -> 1e21，1e-07 -> 1e-7（去 + 与指数前导零）。
    exponent = re.match(r"^(.+?)[eE]([+-]?)(\d+)$", serialized)
    if exponent is not None:
        mantissa = exponent.group(1)
        sign = "-" if exponent.group(2) == "-" else ""
        digits = exponent.group(3).lstrip("0") or "0"
        return f"{mantissa}e{sign}{digits}"
    # 无指数：JS String() 对整值浮点给整数形式（1.0 -> "1"），Python repr 给 "1.0"。
    if value.is_integer():
        return str(int(value))
    return serialized


def _canonical_value(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _canonical_number(value)  # type: ignore[arg-type]
    if isinstance(value, str):
        # ensure_ascii=False：U+2028/U+2029 与非 ASCII 字面保留（RFC 8785）。
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(_canonical_value(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        inner = ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":"))
            + ":"
            + _canonical_value(value[key])
            for key in keys
        )
        return "{" + inner + "}"
    raise TypeError(f"JCS: cannot canonicalize {type(value).__name__}")


def canonicalize(value: object) -> str:
    """RFC 8785 规范化序列化（键序无关，确定性）。"""
    return _canonical_value(value)


def content_digest(value: object) -> str:
    """Content-addressed digest：``sha256:<hex(JCS(value) 的 UTF-8 字节)>``。"""
    return "sha256:" + hashlib.sha256(canonicalize(value).encode("utf-8")).hexdigest()
