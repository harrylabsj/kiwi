"""ReconciliationService 门面：与 14 个 MCP 工具一一对应的核心操作 + 管理确认路由。

prepare/confirm 分离（§12.2）：本模块 prepare_* 只产候选；confirm 只经
ConfirmationRouter（管理页）执行。workspace_id 来自服务端认证上下文。
"""
from __future__ import annotations

import base64
import datetime
import json
import threading
import uuid

from . import ENGINE_VERSION, SCHEMA_VERSION
from .domain import (CASE_DRAFT, CASE_READY, CASE_REVIEW_REQUIRED, CASE_RUNNING,
                     JOB_FAILED, JOB_PARTIAL, JOB_QUEUED, JOB_RUNNING, JOB_SUCCEEDED,
                     MAX_PAGE_LIMIT, OBJECT_CONFIRMED, RUN_FAILED, RUN_PARTIAL,
                     RUN_SUCCEEDED)
from .errors import (AccessDenied, IdempotencyConflict, InvalidInput, NotFound,
                     VersionConflict)
from .export.service import ExportService
from .ingest.service import IngestService
from .mapping.service import MappingService
from .matching.engine import MatchEngine
from .money import canonical_hash
from .reconcile.engine import ReconcileEngine
from .review.service import ReviewService
from .rules.registry import RuleRegistry
from .storage.db import Database
from .storage.files import FileStore


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


class Cursor:
    """分页 cursor 绑定 query_digest 与 run_id（api-contracts）。"""

    @staticmethod
    def encode(offset: int, query_digest: str) -> str:
        raw = json.dumps({"o": offset, "q": query_digest})
        return base64.urlsafe_b64encode(raw.encode()).decode()

    @staticmethod
    def decode(cursor: str, query_digest: str) -> int:
        try:
            data = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
        except Exception as exc:
            raise InvalidInput("invalid cursor") from exc
        if data.get("q") != query_digest:
            raise InvalidInput("cursor does not match query; issue a new query")
        return int(data["o"])


class ReconciliationService:
    def __init__(self, root: str, workspace_id: str = "local",
                 actor_id: str = "local-admin"):
        self.root = root
        self.workspace_id = workspace_id  # 服务端认证上下文，不接受模型传入
        self.actor_id = actor_id
        self.db = Database(f"{root}/freight.db")
        self.files = FileStore(root)
        self.mappings = MappingService(self.db)
        self.ingest = IngestService(self.db, self.files, self.mappings)
        self.matching = MatchEngine(self.db)
        self.rules = RuleRegistry(self.db)
        self.reconcile = ReconcileEngine(self.db)
        self.reviews = ReviewService(self.db)
        self.exports = ExportService(self.db, self.files)
        self._jobs: dict[str, threading.Thread] = {}
        self._recover_interrupted_jobs()

    def _recover_interrupted_jobs(self) -> None:
        """启动时清扫崩溃残留：job 线程是进程内的，进程重启后库里仍挂着
        QUEUED/RUNNING 的 job 永远等不到终态。一律标记 FAILED(RUN_INTERRUPTED)
        并给出恢复动作；卡在 RUNNING 的案件回到 READY，可立即重跑。
        输入由摘要冻结，重跑是确定性的（§16.1）。
        """
        now = _now()
        err = json.dumps({
            "code": "RUN_INTERRUPTED",
            "message": "connector process exited before the job reached a terminal"
                       " state; no partial amounts were committed as final",
            "retryable": True,
            "recovery_action": "call freight_start_run again; inputs are frozen by"
                               " digest so the re-run is deterministic",
        }, ensure_ascii=False)
        with self.db.conn:
            cur = self.db.conn.execute(
                "UPDATE jobs SET status=?, error=?, finished_at=?"
                " WHERE status IN (?, ?)",
                (JOB_FAILED, err, now, JOB_QUEUED, JOB_RUNNING))
            if cur.rowcount:
                self.db.conn.execute(
                    "UPDATE cases SET status=?, updated_at=? WHERE status=?",
                    (CASE_READY, now, CASE_RUNNING))

    def close(self) -> None:
        self.db.close()

    # ---------------------------------------------------------------- 工具面
    def freight_create_case(self, title: str, carrier_id: str, period_from: str,
                            period_to: str, amount_basis: str = "GROSS",
                            currency: str = "CNY",
                            history_coverage: tuple[str, str] | None = None,
                            idempotency_key: str | None = None,
                            **_) -> dict:
        from .money import instant
        if currency != "CNY":
            raise InvalidInput("first version supports CNY only")
        instant(period_from)
        instant(period_to)
        if period_to <= period_from:
            raise InvalidInput("period_to must be after period_from")
        digest = canonical_hash({"title": title, "carrier": carrier_id,
                                 "from": period_from, "to": period_to,
                                 "basis": amount_basis})
        if idempotency_key:
            existing = self._idem_lookup("create_case", idempotency_key, digest)
            if existing:
                return (self.get_case(existing["case_id"])
                        if isinstance(existing, dict) and "case_id" in existing
                        else existing)
        case_id = _new_id("CASE")
        now = _now()
        with self.db.conn:
            self.db.conn.execute(
                "INSERT INTO cases (id, workspace_id, title, carrier_id, currency,"
                " amount_basis, period_from, period_to, history_coverage_from,"
                " history_coverage_to, status, case_revision, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (case_id, self.workspace_id, title, carrier_id, currency, amount_basis,
                 period_from, period_to, history_coverage[0] if history_coverage else None,
                 history_coverage[1] if history_coverage else None,
                 CASE_DRAFT, 1, now, now))
            self.db.conn.execute(
                "INSERT INTO audit_events (at, actor_id, event, case_id, detail)"
                " VALUES (?,?,?,?,?)",
                (now, self.actor_id, "case_created", case_id,
                 json.dumps({"title": title, "carrier": carrier_id})))
            if idempotency_key:
                self._idem_store("create_case", idempotency_key, digest,
                                 {"case_id": case_id})
        return self.get_case(case_id)

    def freight_register_asset(self, case_id: str, upload_path: str, kind: str,
                               declared_total_minor: int | None = None,
                               expected_revision: int | None = None,
                               idempotency_key: str | None = None, **kw) -> dict:
        case = self.get_case(case_id)
        if expected_revision is not None and case["case_revision"] != expected_revision:
            raise VersionConflict("case revision mismatch")
        digest = canonical_hash({"case": case_id, "kind": kind})
        if idempotency_key:
            existing = self._idem_lookup("register_asset", idempotency_key, digest)
            if existing:
                return (self.ingest.get_asset(existing["asset_id"])
                        if isinstance(existing, dict) and "asset_id" in existing
                        else existing)
        asset = self.ingest.register_asset(
            self.workspace_id, case_id, kind, upload_path, self.actor_id,
            declared_total_minor=declared_total_minor,
            scope_note=kw.get("scope_note"))
        with self.db.conn:
            self.db.conn.execute(
                "UPDATE cases SET case_revision=case_revision+1, updated_at=? WHERE id=?",
                (_now(), case_id))
            if idempotency_key:
                self._idem_store("register_asset", idempotency_key, digest,
                                 {"asset_id": asset["asset_id"]})
        return asset

    def freight_inspect_asset(self, asset_id: str, cursor: str | None = None,
                              limit: int = 20, **_) -> dict:
        return self.ingest.inspect_asset(asset_id, offset=self._offset(cursor, asset_id),
                                         limit=self._limit(limit))

    def freight_prepare_mapping(self, case_id: str, kind: str, header: list[str],
                                fields: dict | None = None,
                                expected_revision: int | None = None, **_) -> dict:
        self._require_case(case_id, expected_revision)
        doc = self.mappings.prepare(self.workspace_id, case_id, kind, header, fields)
        digest = canonical_hash({"kind": kind, "structure": doc["structure_digest"]})
        req_id, nonce = self._new_confirmation("mapping", case_id, digest,
                                               {"mapping_version_id": doc["id"]})
        doc["confirmation_id"] = req_id
        doc["confirm_route"] = f"/admin/confirmations/{req_id}/confirm"
        return doc

    def freight_prepare_rate_rules(self, case_id: str,
                                   expected_revision: int | None = None, **_) -> dict:
        """把已导入（DRAFT）的费率规则打包为待确认束：重叠/区间/公式检查不通过则拒绝。"""
        self._require_case(case_id, expected_revision)
        drafts = [dict(r) for r in self.db.conn.execute(
            "SELECT * FROM rate_rules WHERE case_id=? AND status='DRAFT'",
            (case_id,)).fetchall()]
        if not drafts:
            raise InvalidInput("no draft rules to prepare; import a rates file first")
        docs = [self.rules._row_to_doc(r) for r in drafts]
        overlaps = self.rules.check_overlaps(docs)
        if overlaps:
            raise InvalidInput(f"rule intervals overlap: {overlaps}", field_path="rules",
                               recovery_action="fix effective ranges to be non-overlapping")
        digest = self.rules.bundle_digest(docs)
        req_id, nonce = self._new_confirmation("rule_bundle", case_id, digest,
                                               {"rule_count": len(docs)})
        return {"confirmation_id": req_id, "rule_count": len(docs),
                "bundle_digest": digest,
                "confirm_route": f"/admin/confirmations/{req_id}/confirm"}

    def freight_list_match_candidates(self, case_id: str, cursor: str | None = None,
                                      limit: int = 50, **_) -> dict:
        self._require_case(case_id)
        qd = canonical_hash({"case": case_id, "op": "candidates"})
        offset = self._offset(cursor, qd)
        lim = self._limit(limit)
        rows = [dict(r) for r in self.db.conn.execute(
            "SELECT * FROM match_assignments WHERE case_id=? AND state IN"
            " ('AMBIGUOUS','CONFLICT','UNMATCHED') ORDER BY bill_line_id LIMIT ? OFFSET ?",
            (case_id, lim + 1, offset)).fetchall()]
        has_more = len(rows) > lim
        items = [{"bill_line_id": r["bill_line_id"], "state": r["state"],
                  "candidates": json.loads(r["candidates"]),
                  "suggested_trip_id": (r["candidates"] and json.loads(r["candidates"])[0])
                  or r["trip_id"],
                  "method": r["method"]} for r in rows[:lim]]
        out = {"items": items, "next_cursor": self._cursor(offset + lim, qd)
               if has_more else None}
        return out

    def freight_prepare_match(self, case_id: str, bill_line_id: str, trip_id: str,
                              expected_revision: int | None = None, **_) -> dict:
        self._require_case(case_id, expected_revision)
        line = self.db.conn.execute(
            "SELECT * FROM bill_lines WHERE case_id=? AND line_id=?",
            (case_id, bill_line_id)).fetchone()
        if line is None:
            raise NotFound("bill line not found")
        trip = self.db.conn.execute(
            "SELECT * FROM trips WHERE case_id=? AND trip_id=?", (case_id, trip_id)
        ).fetchone()
        if trip is None:
            raise NotFound("trip not found")
        if trip["carrier_id"] != line["carrier_id"]:
            raise InvalidInput("carrier mismatch; cross-carrier matching is forbidden")
        digest = canonical_hash({"line": bill_line_id, "trip": trip_id})
        req_id, _ = self._new_confirmation("match", case_id, digest,
                                           {"bill_line_id": bill_line_id,
                                            "trip_id": trip_id})
        return {"confirmation_id": req_id, "bill_line_id": bill_line_id,
                "trip_id": trip_id, "state": "PENDING_CONFIRMATION",
                "confirm_route": f"/admin/confirmations/{req_id}/confirm"}

    def freight_start_run(self, case_id: str, expected_revision: int | None = None,
                          idempotency_key: str | None = None,
                          supersedes_run_id: str | None = None, **_) -> dict:
        case = self._require_case(case_id, expected_revision)
        digest = canonical_hash({"case": case_id, "supersedes": supersedes_run_id})
        if idempotency_key:
            existing = self._idem_lookup("start_run", idempotency_key, digest)
            if existing:
                return existing
        job_id = _new_id("JOB")
        now = _now()
        with self.db.conn:
            self.db.conn.execute(
                "INSERT INTO jobs (id, case_id, workspace_id, operation, status,"
                " idempotency_key, request_digest, payload, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (job_id, case_id, self.workspace_id, "start_run", JOB_QUEUED,
                 idempotency_key, digest,
                 json.dumps({"supersedes_run_id": supersedes_run_id}), now))
            self.db.conn.execute(
                "UPDATE cases SET status=?, updated_at=? WHERE id=?",
                (CASE_RUNNING, now, case_id))
            if idempotency_key:
                self._idem_store("start_run", idempotency_key, digest, job_id)
        thread = threading.Thread(target=self._execute_run_job, args=(job_id, case),
                                  daemon=True)
        self._jobs[job_id] = thread
        thread.start()
        return {"job_id": job_id, "status": JOB_QUEUED,
                "note": "import/re-run returns job_id; poll freight_get_job (§18.2)"}

    def _execute_run_job(self, job_id: str, case: dict) -> None:
        try:
            with self.db.conn:
                self.db.conn.execute("UPDATE jobs SET status=?, started_at=? WHERE id=?",
                                     (JOB_RUNNING, _now(), job_id))
            run = self._do_run(case["id"])
            final_status = JOB_SUCCEEDED if run["status"] == RUN_SUCCEEDED else JOB_PARTIAL
            with self.db.conn:
                self.db.conn.execute(
                    "UPDATE jobs SET status=?, result=?, finished_at=? WHERE id=?",
                    (final_status, json.dumps({"run_id": run["run_id"],
                                               "status": run["status"]}),
                     _now(), job_id))
        except Exception as exc:  # noqa: BLE001 — job 失败要落库而不是让线程静默死掉
            with self.db.conn:
                self.db.conn.execute(
                    "UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?",
                    (JOB_FAILED, json.dumps({"code": "RUN_FAILED", "message": str(exc)}),
                     _now(), job_id))

    def _do_run(self, case_id: str, supersedes_run_id: str | None = None) -> dict:
        case = self._require_case(case_id)
        supersedes = supersedes_run_id
        if supersedes is None:
            row = self.db.conn.execute(
                "SELECT run_id FROM runs WHERE case_id=? ORDER BY created_at DESC LIMIT 1",
                (case_id,)).fetchone()
            supersedes = row[0] if row else None
        assets = [dict(r) for r in self.db.conn.execute(
            "SELECT * FROM assets WHERE case_id=?", (case_id,)).fetchall()]
        input_digest = canonical_hash(
            sorted(({"id": a["id"], "sha256": a["sha256"], "kind": a["kind"]}
                    for a in assets), key=lambda x: x["id"]))
        mapping_digest = canonical_hash([
            self.mappings.get_confirmed(case_id, k) or {}
            for k in ("bill", "trips", "rates", "waiting", "receipts", "pod")])
        amount_complete = self.ingest.case_amount_complete(case_id) and all(
            a["declared_total_minor"] is None
            or a["declared_total_minor"] == a["parsed_total_minor"] for a in assets)

        match_stats = self.matching.run(case_id, case)
        assignments = [dict(r) for r in self.db.conn.execute(
            "SELECT * FROM match_assignments WHERE case_id=?", (case_id,)).fetchall()]
        matching_digest = canonical_hash(sorted(
            ({"line": a["bill_line_id"], "trip": a["trip_id"], "state": a["state"]}
             for a in assignments), key=lambda x: (x["line"], x["state"])))
        rules = self.rules.load_confirmed(case_id, case["workspace_id"])
        rule_bundle_digest = self.rules.bundle_digest(rules)

        pod_index_provided = self.db.conn.execute(
            "SELECT COUNT(*) FROM evidence_links WHERE case_id=? AND kind='POD'",
            (case_id,)).fetchone()[0] > 0
        groups, out_of_scope = self.reconcile.build_groups(case, pod_index_provided)
        outcome = self.reconcile.reconcile_all(groups, rules, out_of_scope)
        summary, results = outcome["summary"], outcome["results"]
        unresolved_line_count = summary["bill_line_count"] - summary["comparable_line_count"]

        run_id = _new_id("RUN")
        now = _now()
        history_note = self._history_note(case)
        with self.db.conn:
            self.db.conn.execute(
                "INSERT INTO runs (run_id, case_id, workspace_id, case_revision,"
                " rule_bundle_digest, mapping_digest, matching_digest, input_digest,"
                " engine_version, source_ids, created_at, status, bill_line_count,"
                " comparable_line_count, unresolved_line_count, out_of_scope_line_count,"
                " source_signed_total_minor, comparable_billed_minor,"
                " unresolved_billed_minor, out_of_scope_billed_minor, amount_complete,"
                " history_coverage_note, supersedes_run_id, summary)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, case_id, case["workspace_id"], case["case_revision"],
                 rule_bundle_digest, mapping_digest, matching_digest, input_digest,
                 ENGINE_VERSION, json.dumps([a["id"] for a in assets]), now,
                 RUN_SUCCEEDED if amount_complete else RUN_PARTIAL,
                 summary["bill_line_count"], summary["comparable_line_count"],
                 unresolved_line_count,
                 summary["out_of_scope_line_count"],
                 summary["source_signed_total_minor"], summary["comparable_billed_minor"],
                 summary["unresolved_billed_minor"], summary["out_of_scope_billed_minor"],
                 1 if amount_complete else 0, history_note, supersedes,
                 json.dumps(summary)))
            for g in groups:
                self.db.conn.execute(
                    "INSERT INTO charge_groups (run_id, group_id, workspace_id,"
                    " carrier_id, trip_id, service_leg_id, charge_code, occurrence_id,"
                    " currency, amount_basis, service_time, route_id, vehicle_class,"
                    " match_state, trip_status, pod_state, billed_minor, line_ids, event,"
                    " rules) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (run_id, g["group_id"], g["workspace_id"], g["carrier_id"],
                     g["trip_id"], g["service_leg_id"], g["charge_code"],
                     g["occurrence_id"], g["currency"], g["amount_basis"],
                     g["service_time"], g["route_id"], g["vehicle_class"],
                     g["match_state"], g["trip_status"], g["pod_state"],
                     g["billed_minor"], json.dumps([b["line_id"] for b in g["bill_lines"]]),
                     json.dumps(g["event"]), json.dumps([])))
                res = next(r for r in results if r["group_id"] == g["group_id"])
                self.db.conn.execute(
                    "INSERT INTO results (run_id, group_id, comparison_status,"
                    " evidence_status, billed_minor, expected_minor, delta_minor,"
                    " rule_ref, issues, trace, source_refs, result_digest)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (run_id, g["group_id"], res["comparison_status"],
                     res["evidence_status"], res["billed_minor"], res["expected_minor"],
                     res["delta_minor"], res["rule_ref"], json.dumps(res["issues"]),
                     json.dumps(res["trace"]), json.dumps(res["source_refs"]),
                     res["result_digest"]))
                for code in res["issues"]:
                    self.db.conn.execute(
                        "INSERT INTO issues (run_id, group_id, code, severity, message,"
                        " evidence) VALUES (?,?,?,?,?,?)",
                        (run_id, g["group_id"], code,
                         "high" if code in ("AMOUNT_HIGH", "DUPLICATE_SUSPECT",
                                            "REVERSAL_INVALID") else "normal",
                         self._issue_message(code, g),
                         json.dumps({"source_refs": res["source_refs"],
                                     "rule_ref": res["rule_ref"]},
                                    ensure_ascii=False)))
                for b in g["bill_lines"]:  # 唯一消费：行只归属本 run 的本组
                    self.db.conn.execute(
                        "UPDATE bill_lines SET consumption_run=?, consumption_group=?"
                        " WHERE case_id=? AND line_id=?",
                        (run_id, g["group_id"], case_id, b["line_id"]))
            for item in out_of_scope:
                line = item["line"]
                self.db.conn.execute(
                    "INSERT INTO issues (run_id, group_id, code, severity, message,"
                    " evidence) VALUES (?,?,?,?,?,?)",
                    (run_id, "__case__", item["issue"], "normal",
                     f"line {line['line_id']} 排除出本案件运算：{item['issue']}",
                     json.dumps({"line_id": line["line_id"]})))
                self.db.conn.execute(
                    "UPDATE bill_lines SET consumption_run=?, consumption_group=?"
                    " WHERE case_id=? AND line_id=?",
                    (run_id, "__out_of_scope__", case_id, line["line_id"]))
            for trip_id in self.reconcile.not_billed_trips(case):  # 反向遗漏（§7.3）
                self.db.conn.execute(
                    "INSERT INTO issues (run_id, group_id, code, severity, message,"
                    " evidence) VALUES (?,?,?,?,?,?)",
                    (run_id, "__case__", "NOT_BILLED_IN_PROVIDED_SCOPE", "normal",
                     f"trip {trip_id} 已执行但未出现在所提供账单；提醒跨期确认，不算节省",
                     json.dumps({"trip_id": trip_id})))
            parse_failures = self.db.conn.execute(
                "SELECT COUNT(*) FROM source_rows WHERE case_id=? AND parse_status='FAILED'",
                (case_id,)).fetchone()[0]
            if parse_failures:
                self.db.conn.execute(
                    "INSERT INTO issues (run_id, group_id, code, severity, message,"
                    " evidence) VALUES (?,?,?,?,?,?)",
                    (run_id, "__case__", "PARSE_FAILED", "high",
                     f"{parse_failures} 行解析失败，相关金额未进入运算",
                     json.dumps({"count": parse_failures})))
            self.db.conn.execute(
                "UPDATE cases SET status=?, case_revision=case_revision+1, updated_at=?"
                " WHERE id=?", (CASE_REVIEW_REQUIRED, now, case_id))
            self.db.conn.execute(
                "INSERT INTO audit_events (at, actor_id, event, case_id, run_id, detail)"
                " VALUES (?,?,?,?,?,?)",
                (now, self.actor_id, "run_completed", case_id, run_id,
                 json.dumps({"net_difference_minor": summary["net_difference_minor"]})))
        stale = self.reviews.mark_stale_for_run(case_id, run_id)
        if stale:
            with self.db.conn:
                self.db.conn.execute(
                    "INSERT INTO audit_events (at, actor_id, event, case_id, run_id,"
                    " detail) VALUES (?,?,?,?,?,?)",
                    (_now(), self.actor_id, "decisions_stale", case_id, run_id,
                     json.dumps({"stale": stale})))
        run = dict(self.db.conn.execute("SELECT * FROM runs WHERE run_id=?",
                                        (run_id,)).fetchone())
        run["summary"] = summary
        return run

    def freight_get_job(self, job_id: str, **_) -> dict:
        row = self.db.conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise NotFound("job not found")
        return {"job_id": row["id"], "status": row["status"], "operation": row["operation"],
                "result": json.loads(row["result"]) if row["result"] else None,
                "error": json.loads(row["error"]) if row["error"] else None,
                "created_at": row["created_at"], "finished_at": row["finished_at"]}

    def freight_get_summary(self, run_id: str, **_) -> dict:
        run = self.db.conn.execute("SELECT * FROM runs WHERE run_id=?",
                                   (run_id,)).fetchone()
        if run is None:
            raise NotFound("run not found")
        summary = json.loads(run["summary"]) if run["summary"] else {}
        denom = summary.get("abs_total_billed_minor", 0)
        num = summary.get("abs_comparable_billed_minor", 0)
        return {
            "run_id": run_id, "case_id": run["case_id"], "status": run["status"],
            "amount_complete": bool(run["amount_complete"]),
            "summary": summary,
            "coverage": {
                "comparable_lines": f'{run["comparable_line_count"]}/{run["bill_line_count"]}',
                "amount_ratio_abs": (num / denom) if denom else None,
                "coverage_note": "金额覆盖使用绝对账单行金额，避免冲销掩盖（§14）",
            },
            "history_coverage_note": run["history_coverage_note"],
            "supersedes_run_id": run["supersedes_run_id"],
        }

    def freight_list_issues(self, run_id: str, code: str | None = None,
                            cursor: str | None = None, limit: int = 50, **_) -> dict:
        run = self.db.conn.execute("SELECT case_id FROM runs WHERE run_id=?",
                                   (run_id,)).fetchone()
        if run is None:
            raise NotFound("run not found")
        qd = canonical_hash({"run": run_id, "code": code})
        offset = self._offset(cursor, qd)
        lim = self._limit(limit)
        if code:
            rows = self.db.conn.execute(
                "SELECT * FROM issues WHERE run_id=? AND code=? ORDER BY id LIMIT ?"
                " OFFSET ?", (run_id, code, lim + 1, offset)).fetchall()
        else:
            rows = self.db.conn.execute(
                "SELECT * FROM issues WHERE run_id=? ORDER BY id LIMIT ? OFFSET ?",
                (run_id, lim + 1, offset)).fetchall()
        items = [{"id": r["id"], "group_id": r["group_id"], "code": r["code"],
                  "severity": r["severity"], "message": r["message"],
                  "evidence": json.loads(r["evidence"])} for r in rows[:lim + 1]]
        has_more = len(items) > lim
        return {"items": items[:lim], "next_cursor": self._cursor(offset + lim, qd)
                if has_more else None}

    def freight_get_evidence(self, run_id: str, group_id: str, **_) -> dict:
        """四栏复核证据（§12.1 F）：原账单定位 + 运输 + 规则/凭证 + 计算轨迹。脱敏投影。"""
        g = self.db.conn.execute(
            "SELECT * FROM charge_groups WHERE run_id=? AND group_id=?",
            (run_id, group_id)).fetchone()
        if g is None:
            raise NotFound("group not found in run")
        case_id = _case_of_run(self.db, run_id)
        result = self.db.conn.execute(
            "SELECT * FROM results WHERE run_id=? AND group_id=?",
            (run_id, group_id)).fetchone()
        lines = []
        for line_id in json.loads(g["line_ids"]):
            line = self.db.conn.execute(
                "SELECT * FROM bill_lines WHERE case_id=? AND line_id=?",
                (case_id, line_id)).fetchone()
            if line is not None:
                src = self.db.conn.execute(
                    "SELECT sheet, row_number, parse_status FROM source_rows"
                    " WHERE asset_id=? AND row_number=? LIMIT 1",
                    (line["asset_id"], line["row_number"])).fetchone()
                lines.append({
                    "line_id": line_id,
                    "amount_minor": line["amount_minor"],
                    "reversal_of": line["reversal_of"],
                    "locator": {"asset_id": line["asset_id"],
                                "row": line["row_number"],
                                "sheet": src["sheet"] if src else None},
                })
        trip = None
        if g["trip_id"]:
            t = self.db.conn.execute(
                "SELECT * FROM trips WHERE case_id=? AND trip_id=?",
                (case_id, g["trip_id"])).fetchone()
            if t is not None:
                trip = {"trip_id": t["trip_id"], "route_id": t["route_id"],
                        "vehicle_class": t["vehicle_class"],
                        "departed_at": t["departed_at"],
                        "execution_status": t["execution_status"]}
        decision = self.db.conn.execute(
            "SELECT decision_id, decision, status, reason FROM review_decisions"
            " WHERE run_id=? AND group_id=? ORDER BY confirmed_at DESC LIMIT 1",
            (run_id, group_id)).fetchone()
        return {
            "group": {"group_id": g["group_id"], "trip_id": g["trip_id"],
                      "charge_code": g["charge_code"],
                      "occurrence_id": g["occurrence_id"], "pod_state": g["pod_state"],
                      "match_state": g["match_state"], "event": json.loads(g["event"])},
            "result": dict(result) if result else None,
            "bill_lines": lines,
            "trip": trip,
            "rules": json.loads(g["rules"]),
            "decision": dict(decision) if decision else None,
        }

    def freight_prepare_review(self, case_id: str, run_id: str, group_id: str,
                               decision: str, reason: str, **_) -> dict:
        return self.reviews.prepare(self.workspace_id, case_id, run_id, group_id,
                                    decision, reason, self.actor_id)

    def freight_prepare_export(self, case_id: str, run_id: str, purpose: str,
                               projection: str = "carrier", **_) -> dict:
        return self.exports.prepare_export(self.workspace_id, case_id, run_id, purpose,
                                           self.actor_id, projection)

    # ---------------------------------------------------------------- 管理确认
    def admin_confirm(self, confirmation_id: str, nonce: str | None = None) -> dict:
        """管理页最终确认路由：按 kind 分派。GET 无副作用；模型不可达此端点。

        nonce=None 为服务端路径：HTTP 层已验证会话/CSRF/Origin 后由服务器自取凭证。
        """
        req = self.db.conn.execute(
            "SELECT * FROM confirmation_requests WHERE id=?", (confirmation_id,)).fetchone()
        if req is None:
            raise NotFound("confirmation request not found")
        if nonce is None:
            nonce = req["nonce"]
        if req["status"] == "CONFIRMED":
            return {"id": confirmation_id, "status": "CONFIRMED", "idempotent": True}
        kind = req["kind"]
        payload = json.loads(req["payload"])
        now = _now()
        if kind == "mapping":
            out = self.mappings.confirm(payload["mapping_version_id"], self.actor_id,
                                        confirmation_id)
        elif kind == "rule_bundle":
            out = self._confirm_rules(req, payload, now)
        elif kind == "match":
            out = self.matching.apply_manual_match(req["case_id"],
                                                   payload["bill_line_id"],
                                                   payload["trip_id"], self.actor_id)
            with self.db.conn:
                self.db.conn.execute(
                    "UPDATE confirmation_requests SET status='CONFIRMED', actor_id=?,"
                    " confirmed_at=? WHERE id=?", (self.actor_id, now, confirmation_id))
            out["confirmed"] = True
        elif kind == "review":
            out = self.reviews.confirm(confirmation_id, self.actor_id, nonce)
        elif kind == "export":
            out = self.exports.release_export(confirmation_id, self.actor_id, nonce)
        elif kind == "freeze":
            out = self.exports.freeze_run(self.workspace_id, req["case_id"],
                                          payload["run_id"], self.actor_id)
            with self.db.conn:
                self.db.conn.execute(
                    "UPDATE confirmation_requests SET status='CONFIRMED', actor_id=?,"
                    " confirmed_at=? WHERE id=?", (self.actor_id, now, confirmation_id))
            out["confirmed"] = True
        else:
            raise InvalidInput(f"unknown confirmation kind {kind}")
        return out

    def _confirm_rules(self, req, payload, now: str) -> dict:
        case_id = req["case_id"]
        case = self._require_case(case_id)
        with self.db.conn:
            self.db.conn.execute(
                "UPDATE rate_rules SET confirmed=1, status=?, confirmation_ref=?,"
                " workspace_id=? WHERE case_id=? AND status='DRAFT'",
                (OBJECT_CONFIRMED, req["id"], case["workspace_id"], case_id))
            self.db.conn.execute(
                "UPDATE confirmation_requests SET status='CONFIRMED', actor_id=?,"
                " confirmed_at=? WHERE id=?", (self.actor_id, now, req["id"]))
            self.db.conn.execute(
                "UPDATE cases SET case_revision=case_revision+1, updated_at=?"
                " WHERE id=?", (now, case_id))
            self.db.conn.execute(
                "INSERT INTO audit_events (at, actor_id, event, case_id, detail)"
                " VALUES (?,?,?,?,?)",
                (now, self.actor_id, "rule_activated", case_id,
                 json.dumps({"bundle_digest": req["object_digest"],
                             "rule_count": payload.get("rule_count")})))
        return {"bundle_digest": req["object_digest"],
                "rule_count": payload.get("rule_count"), "confirmed": True}

    def admin_confirm_freeze(self, case_id: str, run_id: str) -> dict:
        digest = canonical_hash({"freeze": run_id})
        req_id, _ = self._new_confirmation("freeze", case_id, digest, {"run_id": run_id})
        return self.admin_confirm(req_id, self.db.conn.execute(
            "SELECT nonce FROM confirmation_requests WHERE id=?",
            (req_id,)).fetchone()[0])

    # ---------------------------------------------------------------- 内部工具
    def _case_of(self, run_id: str) -> str:
        return _case_of_run(self.db, run_id)

    def _require_case(self, case_id: str,
                      expected_revision: int | None = None) -> dict:
        row = self.db.conn.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        if row is None:
            raise NotFound("case not found")
        case = dict(row)
        if case["workspace_id"] != self.workspace_id:
            raise NotFound("case not found in this workspace")
        if expected_revision is not None and case["case_revision"] != expected_revision:
            raise VersionConflict(
                f"case revision mismatch: sent {expected_revision}, "
                f"current is {case['case_revision']}; re-read the case and retry once "
                f"with current revision, or omit expected_revision",
                recovery_action=f"retry with expected_revision={case['case_revision']}")
        return case

    def get_case(self, case_id: str) -> dict:
        return dict(self._require_case(case_id))

    def _new_confirmation(self, kind: str, case_id: str, digest: str,
                          payload: dict) -> tuple[str, str]:
        req_id, nonce = _new_id("CRF"), uuid.uuid4().hex
        with self.db.conn:
            self.db.conn.execute(
                "INSERT INTO confirmation_requests (id, kind, workspace_id, case_id,"
                " object_digest, payload, status, nonce, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (req_id, kind, self.workspace_id, case_id, digest,
                 json.dumps(payload, ensure_ascii=False), "PENDING", nonce, _now()))
        return req_id, nonce

    def _idem_lookup(self, operation: str, key: str, digest: str) -> dict | None:
        row = self.db.conn.execute(
            "SELECT request_digest, response_ref FROM idempotency_keys WHERE"
            " workspace_id=? AND operation=? AND idempotency_key=?",
            (self.workspace_id, operation, key)).fetchone()
        if row is None:
            return None
        if row["request_digest"] != digest:
            raise IdempotencyConflict(
                "same idempotency key with different content", recovery_action=
                "use a new idempotency key for a different request")
        return json.loads(row["response_ref"]) if row["response_ref"] else {"pending": True}

    def _idem_store(self, operation: str, key: str, digest: str, response: dict) -> None:
        self.db.conn.execute(
            "INSERT OR REPLACE INTO idempotency_keys (workspace_id, operation,"
            " idempotency_key, request_digest, response_ref, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (self.workspace_id, operation, key, digest, json.dumps(response), _now()))
        self.db.conn.commit()

    @staticmethod
    def _limit(limit: int) -> int:
        limit = int(limit)
        if limit < 1:
            return 1
        return min(limit, MAX_PAGE_LIMIT)

    def _offset(self, cursor: str | None, query_digest: str) -> int:
        return Cursor.decode(cursor, query_digest) if cursor else 0

    @staticmethod
    def _cursor(offset: int, query_digest: str) -> str:
        return Cursor.encode(offset, query_digest)

    @staticmethod
    def _issue_message(code: str, g: dict) -> str:
        messages = {
            "AMOUNT_HIGH": "按当前已确认合同规则计算，账单金额高出，待承运商核对",
            "AMOUNT_LOW": "账单金额低于已确认规则应计，存在反向差异",
            "DUPLICATE_SUSPECT": "同一计费对象疑似多收一次；不删行，组差额只计一次",
            "MISSING_POD": "履约凭证缺失或未提供，算术可保留但证据状态不通过",
            "POD_CONFLICT": "履约凭证之间存在矛盾",
            "MISSING_RECEIPT": "实报费用缺少有效凭证，应计未知（不是0）",
            "WAIT_EVIDENCE_INVALID": "等候时间缺失、倒置或证据未确认，不重算等候费",
            "REVERSAL_INVALID": "冲销原行缺失、跨组或超额，保留原负数并阻断该组",
            "RATE_NOT_FOUND": "找不到适用的已确认合同规则，应计未知",
            "RATE_AMBIGUOUS": "同一适用条件命中多条生效规则，应计未知",
            "BASIS_MISMATCH": "含税/未税等金额口径不一致，暂不比较",
            "UNMATCHED": "账单行未找到对应运输执行，待查执行记录",
            "AMBIGUOUS": "存在多个候选运输关联，需人工确认，不猜选",
            "CONFLICT": "编号存在但主体或关键信息冲突",
            "TRIP_NOT_EXECUTED": "对应运输未实际执行，费用不自动通过",
            "RULE_UNCONFIRMED": "适用规则未经过人工确认，不正式计算差异",
            "CURRENCY_UNSUPPORTED": "非本案件币种，隔离处理",
            "HISTORICAL_DUPLICATE_CANDIDATE": "所提供历史范围中疑似重复，标明覆盖与待核条件",
            "UNSUPPORTED": "超出首版支持范围的费用类型",
        }
        return messages.get(code, code)

    def _history_note(self, case: dict) -> str:
        if case["history_coverage_from"] and case["history_coverage_to"]:
            count = self.db.conn.execute(
                "SELECT COUNT(*) FROM trips WHERE case_id=?",
                (f'{case["id"]}::history',)).fetchone()[0]
            if count:
                return (f"历史台账覆盖 {case['history_coverage_from']} ~ "
                        f"{case['history_coverage_to']}（{count} 条），已做同车次查重")
            return (f"声明历史覆盖 {case['history_coverage_from']} ~ "
                    f"{case['history_coverage_to']}，但未提供历史台账，未做历史查重")
        return "未提供历史台账，未做历史查重（不说“已排除历史重复”，§7.3）"


def _case_of_run(db: Database, run_id: str) -> str:
    row = db.conn.execute("SELECT case_id FROM runs WHERE run_id=?", (run_id,)).fetchone()
    return row[0] if row else ""
