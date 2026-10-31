"""规则注册表（§8）：已确认费率规则的束版本、重叠检查与候选选择。

- 未确认规则不进入 bundle，不参与计算。
- 同一适用条件命中两条生效规则 → RATE_AMBIGUOUS；找不到 → RATE_NOT_FOUND。
- 不设"更晚文件自动覆盖一切"的隐式优先级；中途调价用非重叠区间表达。
"""
from __future__ import annotations

import json

from ..domain import OBJECT_CONFIRMED
from ..errors import InvalidInput
from ..money import canonical_hash, instant


class RuleRegistry:
    def __init__(self, db):
        self.db = db

    def load_confirmed(self, case_id: str, workspace_id: str | None = None) -> list[dict]:
        rows = self.db.conn.execute(
            "SELECT * FROM rate_rules WHERE case_id=? AND status=? AND confirmed=1",
            (case_id, OBJECT_CONFIRMED)).fetchall()
        docs = [self._row_to_doc(r) for r in rows]
        if workspace_id is not None:
            for d in docs:
                d["workspace_id"] = workspace_id
        return docs

    @staticmethod
    def _row_to_doc(r) -> dict:
        return {"rule_id": r["rule_id"], "version": r["version"], "carrier_id": r["carrier_id"],
                "route_id": r["route_id"], "vehicle_class": r["vehicle_class"],
                "charge_code": r["charge_code"], "currency": r["currency"],
                "amount_basis": r["amount_basis"], "effective_from": r["effective_from"],
                "effective_to": r["effective_to"], "formula": r["formula"],
                "rate_minor": r["rate_minor"], "free_seconds": r["free_seconds"],
                "block_seconds": r["block_seconds"], "cap_minor": r["cap_minor"],
                "confirmed": bool(r["confirmed"]),
                "confirmation_ref": r["confirmation_ref"],
                "source_refs": json.loads(r["source_refs"])}

    def bundle_digest(self, rules: list[dict]) -> str:
        return canonical_hash(sorted(rules, key=lambda r: (r["rule_id"], r["version"])))

    def check_overlaps(self, rules: list[dict]) -> list[dict]:
        """同 scope 内生效区间重叠检测（激活前的强制检查）。"""
        by_scope: dict[tuple, list[dict]] = {}
        for r in rules:
            scope = (r["carrier_id"], r["route_id"], r["vehicle_class"], r["charge_code"],
                     r["currency"], r["amount_basis"])
            by_scope.setdefault(scope, []).append(r)
        overlaps = []
        for scope, group in by_scope.items():
            group = sorted(group, key=lambda r: instant(r["effective_from"]))
            for a, b in zip(group, group[1:]):
                if instant(b["effective_from"]) < instant(a["effective_to"]):
                    overlaps.append({"scope": scope, "a": a["rule_id"], "b": b["rule_id"],
                                     "overlap_from": b["effective_from"],
                                     "overlap_to": a["effective_to"]})
        return overlaps

    def select(self, group: dict, rules: list[dict]) -> tuple[dict | None, str | None]:
        """为核算组选择规则。返回 (rule, issue_code)；issue 为 None 表示选中。

        语义与参考引擎一致：确认过的规则先按维度过滤，再按计费时点判断生效区间。
        """
        when = instant(group["service_time"])
        scoped = []
        for rule in rules:
            start, end = instant(rule["effective_from"]), instant(rule["effective_to"])
            if end <= start:
                raise InvalidInput("Empty or reversed rule interval.")
            keys = ("workspace_id", "carrier_id", "route_id", "vehicle_class", "charge_code")
            if all(rule.get(k) == group[k] for k in keys) and start <= when < end:
                scoped.append(rule)
        if not scoped:
            return None, "RATE_NOT_FOUND"
        if len(scoped) != 1:
            return None, "RATE_AMBIGUOUS"
        return scoped[0], None
