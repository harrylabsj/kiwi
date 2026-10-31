"""匹配引擎（§7）：强关联优先，模糊只作建议；一个 bill_line 只能被一个组消费。

- P1：承运商作用域内 trip_ref 与 trip_id 完全一致且承运商一致。
- P2：双方维护且已确认的别名映射唯一命中。
- P3：路线+车型+日期窗口+费用类型产生候选 —— 仅建议，绝不自动绑定。
- 承运商不一致 → CARRIER_CONFLICT 隔离，禁止跨主体匹配。
"""
from __future__ import annotations

import datetime
import json

from ..domain import (MATCH_AMBIGUOUS, MATCH_CONFLICT, MATCH_EXACT, MATCH_UNMATCHED,
                      MATCH_OUT_OF_SCOPE)
from ..money import instant


class MatchEngine:
    def __init__(self, db, date_window_days: int = 1):
        self.db = db
        self.date_window_days = date_window_days

    def run(self, case_id: str, case: dict, aliases: dict[str, str] | None = None) -> dict:
        """对案件全部未消费 bill_lines 做匹配，写 match_assignments。

        aliases: 已确认的编号映射 {bill_trip_ref: trip_id}（P2，需有确认记录才传入）。
        返回 {assigned, unmatched, ambiguous, conflict, out_of_scope, candidates}。
        """
        aliases = aliases or {}
        trips = {r["trip_id"]: dict(r) for r in self.db.conn.execute(
            "SELECT * FROM trips WHERE case_id=?", (case_id,)).fetchall()}
        lines = [dict(r) for r in self.db.conn.execute(
            "SELECT * FROM bill_lines WHERE case_id=? ORDER BY line_id",
            (case_id,)).fetchall()]
        stats = {"assigned": 0, "unmatched": 0, "ambiguous": 0, "conflict": 0,
                 "out_of_scope": 0, "candidates": {}}
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        period_from = instant(case["period_from"])
        period_to = instant(case["period_to"])
        with self.db.conn:
            for line in lines:
                if line["consumption_run"] is not None:
                    continue  # 已被历史 run 消费的行不再改写
                carrier = line["carrier_id"]
                state, trip_id, method = MATCH_UNMATCHED, None, "NONE"
                candidates: list[str] = []
                if carrier != case["carrier_id"]:
                    state = MATCH_OUT_OF_SCOPE  # 明确不属本案件（跨承运商隔离）
                elif line["trip_ref"]:
                    trip = trips.get(line["trip_ref"])
                    alias_hit = aliases.get(line["trip_ref"])
                    if trip is not None and trip["carrier_id"] == carrier:
                        state, trip_id, method = MATCH_EXACT, trip["trip_id"], "P1"
                    elif alias_hit and alias_hit in trips \
                            and trips[alias_hit]["carrier_id"] == carrier:
                        state, trip_id, method = MATCH_EXACT, alias_hit, "P2"
                    elif trip is not None and trip["carrier_id"] != carrier:
                        state = MATCH_CONFLICT  # CARRIER_CONFLICT：编号存在但主体不符
                    elif alias_hit is not None:
                        state = MATCH_CONFLICT
                    else:
                        # P3 候选：同承运商 + 账期内（仅建议，不自动绑定）
                        for tid, trip in sorted(trips.items()):
                            if trip["carrier_id"] != carrier:
                                continue
                            dep = instant(trip["departed_at"])
                            if period_from <= dep < period_to:
                                candidates.append(tid)
                        if candidates:
                            state = MATCH_AMBIGUOUS
                if line["charge_code"] not in ("BASE", "WAIT", "TOLL"):
                    state = MATCH_OUT_OF_SCOPE
                self.db.conn.execute(
                    "INSERT OR REPLACE INTO match_assignments (case_id, bill_line_id,"
                    " trip_id, occurrence_id, method, state, decided_by, decided_at,"
                    " candidates, version) VALUES (?,?,?,?,?,?,?,?,?,1)",
                    (case_id, line["line_id"], trip_id, line["occurrence_id"], method,
                     state, "system", now, json.dumps(candidates)))
                if state == MATCH_EXACT:
                    stats["assigned"] += 1
                elif state == MATCH_AMBIGUOUS:
                    stats["ambiguous"] += 1
                    stats["candidates"][line["line_id"]] = candidates
                elif state == MATCH_CONFLICT:
                    stats["conflict"] += 1
                elif state == MATCH_OUT_OF_SCOPE:
                    stats["out_of_scope"] += 1
                else:
                    stats["unmatched"] += 1
        return stats

    def apply_manual_match(self, case_id: str, bill_line_id: str, trip_id: str,
                           actor_id: str) -> dict:
        """人工确认关联（管理页确认后调用；模型只能 prepare）。"""
        trip = self.db.conn.execute(
            "SELECT * FROM trips WHERE case_id=? AND trip_id=?",
            (case_id, trip_id)).fetchone()
        line = self.db.conn.execute(
            "SELECT * FROM bill_lines WHERE case_id=? AND line_id=?",
            (case_id, bill_line_id)).fetchone()
        if trip is None or line is None:
            from ..errors import NotFound
            raise NotFound("trip or bill line not found")
        if trip["carrier_id"] != line["carrier_id"]:
            from ..errors import InvalidInput
            raise InvalidInput("carrier mismatch; cross-carrier matching is forbidden")
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with self.db.conn:
            self.db.conn.execute(
                "INSERT OR REPLACE INTO match_assignments (case_id, bill_line_id, trip_id,"
                " occurrence_id, method, state, decided_by, decided_at, version)"
                " VALUES (?,?,?,?,?,?,?,?,"
                " COALESCE((SELECT version+1 FROM match_assignments WHERE case_id=? AND"
                "  bill_line_id=? AND occurrence_id=?),1))",
                (case_id, bill_line_id, trip_id, line["occurrence_id"], "MANUAL",
                 MATCH_EXACT, actor_id, now, case_id, bill_line_id, line["occurrence_id"]))
        return {"bill_line_id": bill_line_id, "trip_id": trip_id, "method": "MANUAL",
                "decided_by": actor_id}
