"""ExportService（§12.1 H、§16.1、§19.2/19.3）：冻结 → 固定投影导出。

- 冻结前置：金额解析完整、源合计无冲突、行归属守恒（否则只能导草稿）。
- 导出绑定一版 run 与 input_digest；不自动发送；对外投影不含其他承运商报价、
  系统路径、完整联系方式（§19.3）。
"""
from __future__ import annotations

import datetime
import hashlib
import json
import uuid

from ..errors import InvalidInput, NotFound, VersionConflict
from ..money import canonical_hash
from .xlsx import build_markdown, build_workbook


class ExportService:
    def __init__(self, db, file_store):
        self.db = db
        self.files = file_store

    def freeze_run(self, workspace_id: str, case_id: str, run_id: str, actor_id: str,
                   expected_revision: int | None = None) -> dict:
        """具名用户冻结当前运行。金额不完整只能标记 DRAFT_ONLY，不出正式冻结。"""
        case = self.db.conn.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        if case is None or case["workspace_id"] != workspace_id:
            raise NotFound("case not found in workspace")
        if expected_revision is not None and case["case_revision"] != expected_revision:
            raise VersionConflict("case revision changed; re-read before freezing")
        run = self.db.conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if run is None or run["case_id"] != case_id:
            raise NotFound("run not found in case")
        if run["status"] not in ("SUCCEEDED", "PARTIAL"):
            raise InvalidInput("only a finished run can be frozen")
        frozen = bool(run["amount_complete"])
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with self.db.conn:
            self.db.conn.execute(
                "UPDATE cases SET status=?, frozen_run_id=?, case_revision=case_revision+1,"
                " updated_at=? WHERE id=?",
                ("FROZEN" if frozen else "REVIEW_REQUIRED",
                 run_id if frozen else None, now, case_id))
            self.db.conn.execute(
                "INSERT INTO audit_events (at, actor_id, event, case_id, run_id, detail)"
                " VALUES (?,?,?,?,?,?)",
                (now, actor_id, "run_frozen" if frozen else "run_draft_only", case_id,
                 run_id, json.dumps({"amount_complete": bool(run["amount_complete"])})))
        return {"run_id": run_id, "frozen": frozen,
                "note": None if frozen else
                "金额解析不全或源合计不平：只能导出草稿，不能正式冻结（§16.1）"}

    def prepare_export(self, workspace_id: str, case_id: str, run_id: str, purpose: str,
                       actor_id: str, projection: str = "carrier") -> dict:
        """生成导出候选（不发送）。对外投影：仅相关承运商费用行与必要引用。"""
        case = self.db.conn.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        if case is None or case["workspace_id"] != workspace_id:
            raise NotFound("case not found in workspace")
        run = self.db.conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if run is None or run["case_id"] != case_id:
            raise NotFound("run not found in case")
        summary = json.loads(run["summary"]) if run["summary"] else {}
        unresolved = self.db.conn.execute(
            "SELECT COUNT(*) FROM results WHERE run_id=? AND comparison_status<>'COMPARABLE'",
            (run_id,)).fetchone()[0]
        export_id = f"EXP-{uuid.uuid4().hex[:12]}"
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        payload = {"run_id": run_id, "purpose": purpose, "projection": projection,
                   "unresolved_group_count": unresolved}
        with self.db.conn:
            self.db.conn.execute(
                "INSERT INTO exports (export_id, workspace_id, case_id, run_id,"
                " input_digest, projection, purpose, status, actor_id, confirmation_ref,"
                " unresolved_group_count, coverage_note, artifacts, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (export_id, workspace_id, case_id, run_id, run["input_digest"], projection,
                 purpose, "PREPARED", actor_id, None, unresolved,
                 f"可比行 {summary.get('comparable_line_count', 0)}/"
                 f"{summary.get('bill_line_count', 0)}；金额完整性"
                 f"{'完整' if run['amount_complete'] else '不完整'}",
                 json.dumps([]), now))
        digest = canonical_hash(payload)
        req_id = f"CRF-{uuid.uuid4().hex[:12]}"
        nonce = uuid.uuid4().hex
        with self.db.conn:
            self.db.conn.execute(
                "INSERT INTO confirmation_requests (id, kind, workspace_id, case_id,"
                " object_digest, payload, status, nonce, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (req_id, "export", workspace_id, case_id, digest,
                 json.dumps({"export_id": export_id, **payload}, ensure_ascii=False),
                 "PENDING", nonce, now))
        return {"export_id": export_id, "confirmation_id": req_id, "status": "PREPARED",
                "unresolved_group_count": unresolved}

    def release_export(self, confirmation_id: str, actor_id: str, nonce: str) -> dict:
        """管理页确认后生成固定文件：XLSX 十表 + Markdown 说明。不自动发送。"""
        req = self.db.conn.execute(
            "SELECT * FROM confirmation_requests WHERE id=?", (confirmation_id,)).fetchone()
        if req is None:
            raise NotFound("confirmation request not found")
        if req["status"] == "CONFIRMED":
            payload = json.loads(req["payload"])
            return {"export_id": payload.get("export_id"), "status": "RELEASED",
                    "idempotent": True}
        if req["nonce"] != nonce or req["kind"] != "export":
            raise InvalidInput("confirmation nonce mismatch")
        payload = json.loads(req["payload"])
        export_id = payload["export_id"]
        run_id = payload["run_id"]
        case_row = self.db.conn.execute("SELECT * FROM cases WHERE id=?",
                                        (req["case_id"],)).fetchone()
        run = self.db.conn.execute("SELECT * FROM runs WHERE run_id=?",
                                   (run_id,)).fetchone()
        if run is None:
            raise NotFound("run not found")
        groups = [dict(r) for r in self.db.conn.execute(
            "SELECT * FROM charge_groups WHERE run_id=? ORDER BY group_id",
            (run_id,)).fetchall()]
        results = [dict(r) for r in self.db.conn.execute(
            "SELECT * FROM results WHERE run_id=? ORDER BY group_id", (run_id,)).fetchall()]
        issues = [dict(r) for r in self.db.conn.execute(
            "SELECT * FROM issues WHERE run_id=?", (run_id,)).fetchall()]
        decisions = [dict(r) for r in self.db.conn.execute(
            "SELECT * FROM review_decisions WHERE case_id=? ORDER BY confirmed_at",
            (req["case_id"],)).fetchall()]
        assets = [self._asset(r) for r in self.db.conn.execute(
            "SELECT * FROM assets WHERE case_id=?", (req["case_id"],)).fetchall()]
        rules = [self._rule(r) for r in self.db.conn.execute(
            "SELECT * FROM rate_rules WHERE case_id=? AND confirmed=1",
            (req["case_id"],)).fetchall()]
        run_history = [dict(r) for r in self.db.conn.execute(
            "SELECT run_id, status, created_at, supersedes_run_id, summary FROM runs"
            " WHERE case_id=? ORDER BY created_at", (req["case_id"],)).fetchall()]
        summary = json.loads(run["summary"]) if run["summary"] else {}
        data = build_workbook(dict(run), results, groups, issues, decisions, assets,
                              rules, run_history, dict(case_row))
        rel, _ = self.files.write_output(f"{export_id}.xlsx", data)
        md = build_markdown(dict(run), summary, dict(case_row),
                            payload["unresolved_group_count"])
        md_rel, _ = self.files.write_output(f"{export_id}.md", md.encode("utf-8"))
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        artifacts = [{"name": f"{export_id}.xlsx", "path": rel, "kind": "xlsx",
                      "sha256": hashlib.sha256(data).hexdigest()},
                     {"name": f"{export_id}.md", "path": md_rel, "kind": "markdown",
                      "sha256": hashlib.sha256(md.encode("utf-8")).hexdigest()}]
        with self.db.conn:
            self.db.conn.execute(
                "UPDATE exports SET status='RELEASED', confirmation_ref=?, artifacts=?"
                " WHERE export_id=?",
                (req["id"], json.dumps(artifacts, ensure_ascii=False), export_id))
            self.db.conn.execute(
                "UPDATE confirmation_requests SET status='CONFIRMED', actor_id=?,"
                " confirmed_at=? WHERE id=?", (actor_id, now, confirmation_id))
            self.db.conn.execute(
                "INSERT INTO audit_events (at, actor_id, event, case_id, run_id, detail)"
                " VALUES (?,?,?,?,?,?)",
                (now, actor_id, "export_released", req["case_id"], run_id,
                 json.dumps({"export_id": export_id}, ensure_ascii=False)))
        return {"export_id": export_id, "status": "RELEASED", "artifacts": artifacts,
                "note": "导出是核对材料，不是付款指令；对外发送由人执行（§12.1 H）"}

    def mark_downloaded(self, export_id: str, actor_id: str) -> dict:
        row = self.db.conn.execute("SELECT status FROM exports WHERE export_id=?",
                                   (export_id,)).fetchone()
        if row is None:
            raise NotFound("export not found")
        if row["status"] != "RELEASED":
            raise InvalidInput("export not released yet")
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with self.db.conn:
            self.db.conn.execute("UPDATE exports SET status='DOWNLOADED'"
                                 " WHERE export_id=?", (export_id,))
            self.db.conn.execute(
                "INSERT INTO audit_events (at, actor_id, event, detail) VALUES (?,?,?,?)",
                (now, actor_id, "export_downloaded", json.dumps({"export_id": export_id})))
        return {"export_id": export_id, "status": "DOWNLOADED"}

    def _asset(self, r) -> dict:
        return {"asset_id": r["id"], "kind": r["kind"], "original_name": r["original_name"],
                "sha256": r["sha256"], "byte_size": r["byte_size"],
                "detail_rows": r["detail_rows"], "parse_error_rows": r["parse_error_rows"],
                "amount_complete": bool(r["amount_complete"]),
                "imported_at": r["imported_at"]}

    def _rule(self, r) -> dict:
        return {"rule_id": r["rule_id"], "version": r["version"], "route_id": r["route_id"],
                "vehicle_class": r["vehicle_class"], "charge_code": r["charge_code"],
                "formula": r["formula"], "rate_minor": r["rate_minor"],
                "effective_from": r["effective_from"], "effective_to": r["effective_to"],
                "confirmation_ref": r["confirmation_ref"]}
