"""ReconcileEngine（§4/§7/§10/§11）：核算组构建、确定性重算、异常与覆盖摘要。

组粒度是金额汇总的唯一粒度：异常可一组多标签，同一组的差额只进入金额摘要一次。
三分区守恒：source_signed_total = comparable_billed + unresolved_billed + out_of_scope_billed。
结果摘要不含当前时间，保证相同输入重算一致（§16.2）。
"""
from __future__ import annotations

from ..domain import (CHARGE_CODES, COMPARABLE, EVIDENCE_COMPLETE, EVIDENCE_CONFLICT,
                      EVIDENCE_MISSING, FORMULA_FOR_CHARGE, MATCH_EXACT, NOT_COMPARABLE,
                      POD_CONFLICT, POD_MISSING, POD_UNPROVIDED, POD_VERIFIED)
from ..errors import InvalidInput
from ..money import bounded_int, canonical_hash, instant
from ..pricing.calculator import compute_expected


def _new_result(group_id: str, billed: int) -> dict:
    return {"schema_version": "0.1.0", "group_id": group_id,
            "comparison_status": NOT_COMPARABLE, "evidence_status": EVIDENCE_COMPLETE,
            "billed_minor": billed, "expected_minor": None, "delta_minor": None,
            "rule_ref": None, "issues": [], "trace": [], "source_refs": []}


class ReconcileEngine:
    def __init__(self, db):
        self.db = db

    # ------------------------------------------------------------------ 分组
    def build_groups(self, case: dict, pod_index_provided: bool) -> tuple[list[dict], list[dict]]:
        """从持久层构建核算组。组键=承运商+车次+段+费用码+事件+币种+口径（§4.2）。"""
        case_id = case["id"]
        case_carrier = case["carrier_id"]
        trips = {r["trip_id"]: dict(r) for r in self.db.conn.execute(
            "SELECT * FROM trips WHERE case_id=?", (case_id,)).fetchall()}
        lines = [dict(r) for r in self.db.conn.execute(
            "SELECT * FROM bill_lines WHERE case_id=? ORDER BY line_id",
            (case_id,)).fetchall()]
        assignments = {}
        for r in self.db.conn.execute(
                "SELECT * FROM match_assignments WHERE case_id=?", (case_id,)).fetchall():
            assignments[(r["bill_line_id"], r["occurrence_id"])] = dict(r)
        wait_events = {}
        for r in self.db.conn.execute(
                "SELECT * FROM evidence_links WHERE case_id=? AND kind='WAIT'",
                (case_id,)).fetchall():
            wait_events[(r["trip_id"], r["occurrence_id"])] = dict(r)
        receipts: dict[tuple, list[dict]] = {}
        for r in self.db.conn.execute(
                "SELECT * FROM evidence_links WHERE case_id=? AND kind='RECEIPT'",
                (case_id,)).fetchall():
            receipts.setdefault((r["trip_id"], r["occurrence_id"]), []).append(dict(r))
        pods: dict[str, list[dict]] = {}
        for r in self.db.conn.execute(
                "SELECT * FROM evidence_links WHERE case_id=? AND kind='POD'",
                (case_id,)).fetchall():
            pods.setdefault(r["trip_id"], []).append(dict(r))
        history_trip_ids = {r["trip_id"] for r in self.db.conn.execute(
            "SELECT trip_id FROM trips WHERE case_id=?", (f"{case_id}::history",)).fetchall()}

        grouped: dict[tuple, dict] = {}
        out_of_scope: list[dict] = []
        for line in lines:
            carrier = line["carrier_id"]
            if carrier != case_carrier:
                out_of_scope.append({"line": line, "issue": "CARRIER_CONFLICT"})
                continue
            if line["charge_code"] not in CHARGE_CODES:
                out_of_scope.append({"line": line, "issue": "UNSUPPORTED"})
                continue
            if line["currency"] != case["currency"]:
                out_of_scope.append({"line": line, "issue": "CURRENCY_UNSUPPORTED"})
                continue
            asg = assignments.get((line["line_id"], line["occurrence_id"]))
            trip_id = asg["trip_id"] if asg else None
            match_state = asg["state"] if asg else "UNMATCHED"
            key = (carrier, trip_id, line["service_leg_id"], line["charge_code"],
                   line["occurrence_id"], line["currency"], line["amount_basis"])
            g = grouped.get(key)
            if g is None:
                trip = trips.get(trip_id) if trip_id else None
                g = {"group_id": self._group_id(key), "workspace_id": case["workspace_id"],
                     "case_id": case_id, "carrier_id": carrier, "trip_id": trip_id,
                     "service_leg_id": line["service_leg_id"], "charge_code": line["charge_code"],
                     "occurrence_id": line["occurrence_id"], "currency": line["currency"],
                     "amount_basis": line["amount_basis"], "match_state": match_state,
                     "trip_status": trip["execution_status"] if trip else None,
                     "service_time": trip["departed_at"] if trip else None,
                     "route_id": trip["route_id"] if trip else None,
                     "vehicle_class": trip["vehicle_class"] if trip else None,
                     "bill_lines": [], "source_refs": []}
                if trip is not None:
                    g["source_refs"].append(f"trips.csv#trip={trip_id}")
                if trip_id is not None:
                    pod_rows = pods.get(trip_id, [])
                    if any(p["state"] == POD_CONFLICT for p in pod_rows):
                        g["pod_state"] = POD_CONFLICT
                    elif any(p["state"] == POD_VERIFIED for p in pod_rows):
                        g["pod_state"] = POD_VERIFIED
                    elif pod_index_provided or pod_rows:
                        g["pod_state"] = POD_MISSING
                    else:
                        g["pod_state"] = POD_UNPROVIDED
                    g["history_hit"] = trip_id in history_trip_ids
                else:
                    g["pod_state"] = POD_UNPROVIDED
                    g["history_hit"] = False
                grouped[key] = g
            g["bill_lines"].append(line)

        groups = []
        for key in sorted(grouped, key=lambda k: grouped[k]["group_id"]):
            g = grouped[key]
            g["billed_minor"] = sum(l["amount_minor"] for l in g["bill_lines"])
            event = {"elapsed_seconds": None, "time_evidence_verified": False,
                     "receipt_minor": None, "receipt_verified": False, "source_refs": []}
            if g["trip_id"] is not None:
                if g["charge_code"] == "WAIT":
                    ev = wait_events.get((g["trip_id"], g["occurrence_id"]))
                    if ev is not None:
                        event["elapsed_seconds"] = ev["elapsed_seconds"]
                        event["time_evidence_verified"] = ev["state"] == "VERIFIED"
                        if ev["file_ref"]:
                            event["source_refs"].append(f"waiting#{ev['file_ref']}")
                elif g["charge_code"] == "TOLL":
                    rcps = receipts.get((g["trip_id"], g["occurrence_id"]), [])
                    valid = [r for r in rcps if r["state"] == "VERIFIED"
                             and r["amount_minor"] is not None]
                    if valid:
                        event["receipt_minor"] = sum(r["amount_minor"] for r in valid)
                        event["receipt_verified"] = True
                        for r in valid:
                            event["source_refs"].append(f"receipt#{r['content_digest'][:16]}")
            g["event"] = event
            groups.append(g)
        return groups, out_of_scope

    @staticmethod
    def _group_id(key: tuple) -> str:
        carrier, trip_id, leg, charge, occ, currency, basis = key
        parts = [carrier, trip_id or "NOTRIP", leg or "NOLEG", charge, occ, currency, basis]
        return "GRP-" + "-".join(p or "NONE" for p in parts)

    # ------------------------------------------------------------------ 组计算
    def reconcile_group(self, g: dict, rules: list[dict]) -> dict:
        """语义与 04_reference/reference_engine.reconcile_group 一致（金标对齐）。"""
        lines = g["bill_lines"]
        billed = bounded_int(sum(b["amount_minor"] for b in lines))
        issues: list[str] = []
        refs = set(g.get("source_refs", []))
        for b in lines:
            refs.add(b.get("source_ref") or f"bill.csv#line={b['line_id']}")
        r = _new_result(g["group_id"], billed)
        trace = r["trace"]

        def finish(code: str | None = None) -> dict:
            if code:
                issues.append(code)
            r["issues"] = sorted(set(issues))
            r["source_refs"] = sorted(refs)
            r["result_digest"] = canonical_hash(r)
            return r

        if g.get("pod_state") == "MISSING":
            r["evidence_status"] = EVIDENCE_MISSING
            issues.append("MISSING_POD")
        elif g.get("pod_state") == "CONFLICT":
            r["evidence_status"] = EVIDENCE_CONFLICT
            issues.append("POD_CONFLICT")
        elif g.get("pod_state") == "UNPROVIDED" and g.get("trip_id") is not None:
            # 未提供履约凭证索引：不能声称证据完整；进入覆盖缺口而非伪装通过
            r["evidence_status"] = EVIDENCE_MISSING
            issues.append("MISSING_POD")
        if g["currency"] != "CNY":
            return finish("CURRENCY_UNSUPPORTED")
        if g.get("match_state") not in ("EXACT", "CONFIRMED") or not g.get("trip_id"):
            code = g.get("match_state")
            return finish(code if code in ("UNMATCHED", "AMBIGUOUS", "CONFLICT",
                                           "OUT_OF_SCOPE") else "UNMATCHED")
        if g.get("trip_status") != "EXECUTED":
            return finish("TRIP_NOT_EXECUTED")
        # 显式冲销链接（§10.2）：仅限同组、指向组内正数原行、累计不超原额
        byid = {b["line_id"]: b for b in lines}
        credits: dict[str, int] = {}
        for b in lines:
            amount = b["amount_minor"]
            target = b.get("reversal_of")
            if amount < 0:
                orig = byid.get(target)
                if orig is None or orig["amount_minor"] <= 0 \
                        or orig.get("reversal_of") is not None:
                    return finish("REVERSAL_INVALID")
                credits[target] = credits.get(target, 0) - amount
            elif target is not None:
                return finish("REVERSAL_INVALID")
        if any(v > byid[k]["amount_minor"] for k, v in credits.items()):
            return finish("REVERSAL_INVALID")
        if billed < 0:
            return finish("REVERSAL_INVALID")
        when = instant(g["service_time"])
        scoped = []
        for rule in rules:
            start, end = instant(rule["effective_from"]), instant(rule["effective_to"])
            if end <= start:
                raise InvalidInput("Empty or reversed rule interval.")
            if all(rule[k] == g[k] for k in ("workspace_id", "carrier_id", "route_id",
                                             "vehicle_class", "charge_code")) \
                    and start <= when < end:
                scoped.append(rule)
        if not scoped:
            return finish("RATE_NOT_FOUND")
        if len(scoped) != 1:
            return finish("RATE_AMBIGUOUS")
        rule = scoped[0]
        if rule.get("confirmed") is not True or not rule.get("confirmation_ref"):
            return finish("RULE_UNCONFIRMED")
        r["rule_ref"] = f"{rule['rule_id']}@{rule['version']}"
        refs.update(rule.get("source_refs", []))
        if rule["currency"] != g["currency"] or rule["amount_basis"] != g["amount_basis"]:
            return finish("BASIS_MISMATCH")
        if FORMULA_FOR_CHARGE.get(g["charge_code"]) != rule["formula"]:
            return finish("UNSUPPORTED_FORMULA")
        event = dict(g.get("event") or {})
        refs.update(event.get("source_refs", []))
        expected, step_trace, issue = compute_expected(rule, g["charge_code"], event)
        if issue is not None:
            if issue == "WAIT_EVIDENCE_INVALID":
                r["evidence_status"] = EVIDENCE_MISSING
            elif issue == "MISSING_RECEIPT":
                r["evidence_status"] = EVIDENCE_MISSING
            return finish(issue)
        trace.append(step_trace)
        delta = bounded_int(billed - expected)
        r.update(comparison_status=COMPARABLE, expected_minor=expected, delta_minor=delta)
        trace.append(f"DELTA: {billed} - {expected} = {delta}")
        if delta > 0:
            issues.append("AMOUNT_HIGH")
        elif delta < 0:
            issues.append("AMOUNT_LOW")
        if len([b for b in lines if b["amount_minor"] > 0
                and b.get("reversal_of") is None]) > 1:
            issues.append("DUPLICATE_SUSPECT")
        if g.get("history_hit"):
            issues.append("HISTORICAL_DUPLICATE_CANDIDATE")
        return finish()

    # ------------------------------------------------------------------ 全量
    def reconcile_all(self, groups: list[dict], rules: list[dict],
                      out_of_scope_lines: list[dict] | None = None) -> dict:
        out_of_scope_lines = out_of_scope_lines or []
        seen_groups: set[str] = set()
        seen_lines: set[str] = set()
        scopes: set[tuple] = set()
        for g in groups:
            if g["group_id"] in seen_groups:
                raise InvalidInput("Duplicate group id.")
            seen_groups.add(g["group_id"])
            for b in g["bill_lines"]:
                if b["line_id"] in seen_lines:
                    raise InvalidInput("Source line assigned to more than one group.")
                seen_lines.add(b["line_id"])
            scopes.add((g["workspace_id"], g["carrier_id"], g["currency"],
                        g["amount_basis"]))
        results = [self.reconcile_group(g, rules) for g in groups]
        s = {k: 0 for k in ("bill_line_count", "group_count", "comparable_line_count",
                            "comparable_group_count", "source_signed_total_minor",
                            "comparable_billed_minor", "expected_comparable_minor",
                            "unresolved_billed_minor", "out_of_scope_billed_minor",
                            "out_of_scope_line_count", "positive_difference_minor",
                            "negative_difference_minor", "net_difference_minor",
                            "abs_total_billed_minor", "abs_comparable_billed_minor")}
        for g, r in zip(groups, results):
            s["group_count"] += 1
            s["bill_line_count"] += len(g["bill_lines"])
            s["source_signed_total_minor"] += r["billed_minor"]
            absval = sum(abs(b["amount_minor"]) for b in g["bill_lines"])
            s["abs_total_billed_minor"] += absval
            if r["comparison_status"] == COMPARABLE:
                s["comparable_group_count"] += 1
                s["comparable_line_count"] += len(g["bill_lines"])
                s["comparable_billed_minor"] += r["billed_minor"]
                s["expected_comparable_minor"] += r["expected_minor"]
                s["abs_comparable_billed_minor"] += absval
                s["positive_difference_minor"] += max(r["delta_minor"], 0)
                s["negative_difference_minor"] += min(r["delta_minor"], 0)
            else:
                s["unresolved_billed_minor"] += r["billed_minor"]
        for item in out_of_scope_lines:  # 明确不属本案件的行：单独分区，不入组运算
            line = item["line"]
            s["out_of_scope_line_count"] += 1
            s["bill_line_count"] += 1
            s["source_signed_total_minor"] += line["amount_minor"]
            s["abs_total_billed_minor"] += abs(line["amount_minor"])
            s["out_of_scope_billed_minor"] += line["amount_minor"]
        s["net_difference_minor"] = s["positive_difference_minor"] \
            + s["negative_difference_minor"]
        for k, v in s.items():
            bounded_int(v)
        assert s["source_signed_total_minor"] == (s["comparable_billed_minor"]
                                                  + s["unresolved_billed_minor"]
                                                  + s["out_of_scope_billed_minor"]), \
            "bill line attribution is not conserved"
        assert s["comparable_billed_minor"] - s["expected_comparable_minor"] \
            == s["net_difference_minor"], "delta aggregation is not conserved"
        return {"summary": s, "results": results}

    # ------------------------------------------------------------------ 双向遗漏
    def not_billed_trips(self, case: dict) -> list[str]:
        """已执行且在账期内、却未出现在所提供账单的车次（§7.3）。"""
        billed_refs = {r[0] for r in self.db.conn.execute(
            "SELECT trip_ref FROM bill_lines WHERE case_id=? AND trip_ref IS NOT NULL",
            (case["id"],)).fetchall()}
        period_from, period_to = instant(case["period_from"]), instant(case["period_to"])
        missing = []
        for t in self.db.conn.execute(
                "SELECT * FROM trips WHERE case_id=? ORDER BY trip_id",
                (case["id"],)).fetchall():
            if t["execution_status"] != "EXECUTED":
                continue
            dep = instant(t["departed_at"])
            if period_from <= dep < period_to and t["trip_id"] not in billed_refs:
                missing.append(t["trip_id"])
        return missing
