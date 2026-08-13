"""ConditionalOffer 求值器（KNP §13 / §15）。

镜像 Kiwi TS `src/negotiation/condition/evaluator.ts` 的语义：
``conditions`` 命中第一个 ``when`` 条件 → 取对应 ``then_terms``；全不命中 →
回退 ``base_terms``。条件节点为 ``all`` / ``any`` / leaf（``{field, op, value}``）。

field 先查事实字典顶层，再按点分路径下钻。op 词表：eq / neq / gt / gte / lt / lte / in。
"""

from __future__ import annotations

from typing import Any

_OPS = {
    "eq": lambda a, v: a == v,
    "neq": lambda a, v: a != v,
    "gt": lambda a, v: a is not None and a > v,
    "gte": lambda a, v: a is not None and a >= v,
    "lt": lambda a, v: a is not None and a < v,
    "lte": lambda a, v: a is not None and a <= v,
    "in": lambda a, v: a in v,
}


class ConditionalError(ValueError):
    """条件结构 / 求值失败（fail-closed）。"""


def resolve_field(field: str, facts: dict) -> Any:
    if field in facts:
        return facts[field]
    current: Any = facts
    for part in field.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None
    return current


def matches(node: dict, facts: dict) -> bool:
    if not isinstance(node, dict):
        raise ConditionalError("condition node must be an object")
    if "all" in node:
        return all(matches(sub, facts) for sub in node["all"])
    if "any" in node:
        return any(matches(sub, facts) for sub in node["any"])
    if "field" not in node:
        raise ConditionalError("leaf condition must carry field/op/value")
    op = node.get("op")
    if op not in _OPS:
        raise ConditionalError(f"unsupported condition op: {op}")
    actual = resolve_field(str(node["field"]), facts)
    return _OPS[op](actual, node.get("value"))


def evaluate_conditional(conditional: dict, facts: dict) -> dict:
    """命中首条件 → then_terms；否则 base_terms（§13.2）。"""
    conditions = conditional.get("conditions")
    if not isinstance(conditions, list):
        raise ConditionalError("conditional_offer payload must carry conditions array")
    for cond in conditions:
        when = cond.get("when")
        if isinstance(when, dict) and matches(when, facts):
            then_terms = cond.get("then_terms")
            if not isinstance(then_terms, dict):
                raise ConditionalError("matched condition must carry then_terms")
            return then_terms
    base_terms = conditional.get("base_terms")
    if not isinstance(base_terms, dict):
        raise ConditionalError("conditional_offer payload must carry base_terms")
    return base_terms
