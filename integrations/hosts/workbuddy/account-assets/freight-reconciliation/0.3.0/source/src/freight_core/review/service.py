"""ReviewService（§12.1 F/G、§11.2）：版本绑定的人工决定，不改历史算术。

- 模型只能 prepare（生成待确认候选）；confirm 只由管理页以一次性凭证执行。
- 决定绑定 run + group + result_digest；新 run 后摘要不一致 → STALE。
- 接受账单（ACCEPTED_AS_BILLED）保留原始差异与理由，不改 expected。
"""
from __future__ import annotations

import datetime
import json
import uuid

from ..domain import REVIEW_STALE
from ..errors import InvalidInput, NotFound
from ..money import canonical_hash

VALID_DECISIONS = ("CONFIRMED_DIFFERENCE", "ACCEPTED_AS_BILLED", "NEEDS_EVIDENCE",
                   "DISPUTED", "OUT_OF_SCOPE")


class ReviewService:
    def __init__(self, db):
        self.db = db

    def prepare(self, workspace_id: str, case_id: str, run_id: str, group_id: str,
                decision: str, reason: str, actor_id: str,
                source_refs: list[str] | None = None) -> dict:
        """生成复核候选：校验决定与当前 result_digest 绑定，不直接生效。"""
        if decision not in VALID_DECISIONS:
            raise InvalidInput(f"decision must be one of {VALID_DECISIONS}")
        if not reason or not reason.strip():
            raise InvalidInput("reason is required for a review decision")
        result = self.db.conn.execute(
            "SELECT * FROM results WHERE run_id=? AND group_id=?", (run_id, group_id)
        ).fetchone()
        if result is None:
            raise NotFound("result not found for this run/group")
        case = self.db.conn.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        if case is None or case["workspace_id"] != workspace_id:
            raise NotFound("case not found in workspace")
        run = self.db.conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if run is None or run["case_id"] != case_id:
            raise NotFound("run not found in case")
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        payload = {"run_id": run_id, "group_id": group_id,
                   "result_digest": result["result_digest"], "decision": decision,
                   "reason": reason, "actor_id": actor_id,
                   "source_refs": sorted(source_refs or [])}
        req_id = f"CRF-{uuid.uuid4().hex[:12]}"
        nonce = uuid.uuid4().hex
        with self.db.conn:
            self.db.conn.execute(
                "INSERT INTO confirmation_requests (id, kind, workspace_id, case_id,"
                " object_digest, payload, status, nonce, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (req_id, "review", workspace_id, case_id, result["result_digest"],
                 json.dumps(payload, ensure_ascii=False), "PENDING", nonce, now))
        return {"confirmation_id": req_id, "kind": "review", "status": "PENDING",
                "object_digest": result["result_digest"],
                "summary": payload, "confirm_route": f"/admin/confirmations/{req_id}/confirm"}

    def confirm(self, confirmation_id: str, actor_id: str, nonce: str,
                attachments: list[str] | None = None) -> dict:
        """管理页专用：验证一次性凭证后写入决定记录。重复确认返回原结果（幂等）。"""
        req = self.db.conn.execute(
            "SELECT * FROM confirmation_requests WHERE id=?", (confirmation_id,)).fetchone()
        if req is None:
            raise NotFound("confirmation request not found")
        if req["status"] == "CONFIRMED":
            return {"decision_id": req["id"], "status": "CONFIRMED", "idempotent": True}
        if req["nonce"] != nonce:
            raise InvalidInput("confirmation nonce mismatch")
        payload = json.loads(req["payload"])
        decision_id = f"DEC-{uuid.uuid4().hex[:12]}"
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with self.db.conn:
            self.db.conn.execute(
                "INSERT INTO review_decisions (decision_id, workspace_id, case_id, run_id,"
                " group_id, result_digest, actor_id, decision, reason, source_refs, status,"
                " confirmed_at, confirmation_ref, attachments) VALUES (?,?,?,?,?,?,?,?,?,?,"
                "'ACTIVE',?,?,?)",
                (decision_id, req["workspace_id"], req["case_id"], payload["run_id"],
                 payload["group_id"], payload["result_digest"], actor_id,
                 payload["decision"], payload["reason"],
                 json.dumps(payload["source_refs"]), now, req["id"],
                 json.dumps(attachments or [])))
            self.db.conn.execute(
                "UPDATE confirmation_requests SET status='CONFIRMED', actor_id=?,"
                " confirmed_at=? WHERE id=?", (actor_id, now, confirmation_id))
            self.db.conn.execute(
                "INSERT INTO audit_events (at, actor_id, event, case_id, run_id, detail)"
                " VALUES (?,?,?,?,?,?)",
                (now, actor_id, "decision_confirmed", req["case_id"], payload["run_id"],
                 json.dumps({"decision_id": decision_id, "group_id": payload["group_id"]},
                            ensure_ascii=False)))
        return {"decision_id": decision_id, "status": "ACTIVE", "idempotent": False}

    def mark_stale_for_run(self, case_id: str, new_run_id: str) -> int:
        """新 run 后：旧决定所绑 result_digest 与新结果不一致 → STALE（§12.1 G）。"""
        stale = 0
        for d in self.db.conn.execute(
                "SELECT * FROM review_decisions WHERE case_id=? AND status='ACTIVE'",
                (case_id,)).fetchall():
            new_result = self.db.conn.execute(
                "SELECT result_digest FROM results WHERE run_id=? AND group_id=?",
                (new_run_id, d["group_id"])).fetchone()
            still_valid = new_result is not None \
                and new_result["result_digest"] == d["result_digest"]
            if not still_valid:
                with self.db.conn:
                    self.db.conn.execute(
                        "UPDATE review_decisions SET status=? WHERE decision_id=?",
                        (REVIEW_STALE, d["decision_id"]))
                stale += 1
        return stale

    def list_decisions(self, case_id: str, run_id: str | None = None) -> list[dict]:
        sql = "SELECT * FROM review_decisions WHERE case_id=?"
        params = [case_id]
        if run_id:
            sql += " AND run_id=?"
            params.append(run_id)
        rows = self.db.conn.execute(sql + " ORDER BY confirmed_at", params).fetchall()
        return [dict(r) for r in rows]
