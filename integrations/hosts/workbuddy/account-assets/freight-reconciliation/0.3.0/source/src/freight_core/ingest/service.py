"""IngestService（§5/§6）：资产登记 → 安全解析 → 归一化入库 → 控制总数。

- 同一案件内相同 kind + sha256 重复导入返回原 asset（技术幂等，§10.1）。
- 三分区：可比明细 / 不可比待匹配 / 明确不属本案件；解析失败行保留原行并登记。
- 守恒等式：source_detail_signed_total = comparable + unresolved + out_of_scope
  （本表存储 parsed_total；三分区最终在运行层结算，导入层先给出全量有符号合计）。
"""
from __future__ import annotations

import datetime
import json
import uuid
from pathlib import Path

from ..domain import (ASSET_KINDS, MAX_BILL_LINES_PER_CASE, MAX_FILES_PER_CASE,
                      OBJECT_CONFIRMED)
from ..errors import InvalidInput, LimitExceeded, NotFound
from ..money import canonical_hash
from ..storage.files import FileStore
from . import records
from .reader import ParsedFile, read_any

PARSER_VERSION = "ingest-0.1.0"


class IngestService:
    def __init__(self, db, file_store: FileStore, mappings):
        self.db = db
        self.files = file_store
        self.mappings = mappings

    # ---- 内部工具 ----
    def _case(self, case_id: str) -> dict:
        row = self.db.conn.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        if row is None:
            raise NotFound("case not found")
        return dict(row)

    def _audit(self, actor_id: str, event: str, case_id: str | None,
               run_id: str | None = None, detail: dict | None = None) -> None:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.db.conn.execute(
            "INSERT INTO audit_events (at, actor_id, event, case_id, run_id, detail)"
            " VALUES (?,?,?,?,?,?)",
            (now, actor_id, event, case_id, run_id,
             json.dumps(detail or {}, ensure_ascii=False)))

    # ---- 登记 ----
    def register_asset(self, workspace_id: str, case_id: str, kind: str,
                       upload_path: str, actor_id: str, *,
                       declared_total_minor: int | None = None,
                       scope_note: str | None = None,
                       amount_unit: str = "minor") -> dict:
        """登记一个来源文件并完成解析入库。返回 SourceAsset 投影（含 inspect 摘要）。"""
        if kind not in ASSET_KINDS:
            raise InvalidInput(f"unknown asset kind: {kind}")
        case = self._case(case_id)
        if case["workspace_id"] != workspace_id:
            raise NotFound("case not found in this workspace")
        n_files = self.db.conn.execute(
            "SELECT COUNT(*) FROM assets WHERE case_id=?", (case_id,)).fetchone()[0]
        if n_files >= MAX_FILES_PER_CASE:
            raise LimitExceeded(f"at most {MAX_FILES_PER_CASE} files per case")
        if not Path(upload_path).exists():
            raise InvalidInput("upload file does not exist")

        parsed: ParsedFile = read_any(upload_path)
        existing = self.db.conn.execute(
            "SELECT id FROM assets WHERE case_id=? AND kind=? AND sha256=?",
            (case_id, kind, parsed.sha256)).fetchone()
        if existing is not None:  # 技术幂等：同一来源返回原 asset，不生成第二份账单
            row = self.db.conn.execute("SELECT * FROM assets WHERE id=?",
                                       (existing[0],)).fetchone()
            return self._asset_projection(dict(row), reimported=True)

        rel_path, _ = self.files.ingest_file(upload_path)
        asset_id = f"AST-{uuid.uuid4().hex[:12]}"
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()

        # 映射结构检查：确认过的模板必须复用或重新确认
        header = parsed.sheets[0].header if parsed.sheets else []
        structure = self.mappings.evaluate_structure(case_id, kind, header)
        if not structure["reusable_confirmed"]:
            raise InvalidInput(
                "mapping not confirmed for this structure; call freight_prepare_mapping "
                "and confirm it first",
                field_path="mapping", recovery_action="prepare and confirm a mapping profile")

        detail_rows = 0
        parse_error_rows = 0
        parsed_total = 0
        parse_errors: list[dict] = []
        with self.db.conn:
            for sheet in parsed.sheets:
                parser_fn, _ = records.ROW_PARSERS.get(kind, (None, None))
                if parser_fn is None:
                    raise InvalidInput(f"no parser for kind {kind}")
                for row, row_number in zip(sheet.rows, sheet.row_numbers):
                    if "__parse_error__" in row:
                        parse_error_rows += 1
                        parse_errors.append({"sheet": sheet.name, "row": row_number,
                                             "error": row["__parse_error__"]})
                        self._store_source_row(asset_id, case_id, sheet.name, row_number,
                                               kind, row, "FAILED", row["__parse_error__"])
                        continue
                    try:
                        rec = parser_fn(row, row_number, unit=amount_unit)
                        status, error = "OK", None
                    except Exception as exc:  # 解析失败行保留原行并阻断相关计算
                        parse_error_rows += 1
                        parse_errors.append({"sheet": sheet.name, "row": row_number,
                                             "error": str(exc)})
                        self._store_source_row(asset_id, case_id, sheet.name, row_number,
                                               kind, row, "FAILED", str(exc))
                        continue
                    detail_rows += 1
                    self._store_source_row(asset_id, case_id, sheet.name, row_number,
                                           kind, row, status, error)
                    self._store_record(case_id, workspace_id, asset_id, kind, rec)
                    if kind == "bill":
                        parsed_total += rec["amount_minor"]
                        n_lines = self.db.conn.execute(
                            "SELECT COUNT(*) FROM bill_lines WHERE case_id=?",
                            (case_id,)).fetchone()[0]
                        if n_lines > MAX_BILL_LINES_PER_CASE:
                            raise LimitExceeded("bill lines per case exceed cap")

            amount_complete = 1 if parse_error_rows == 0 else 0
            if declared_total_minor is not None and declared_total_minor != parsed_total:
                amount_complete = 0  # SOURCE_TOTAL_MISMATCH：案件完整性阻断（§6.3）
            self.db.conn.execute(
                "INSERT INTO assets (id, workspace_id, case_id, kind, original_name,"
                " sha256, byte_size, imported_at, parser_version, scope_note, mime_type,"
                " selected_sheets, detail_rows, parse_error_rows, declared_total_minor,"
                " parsed_total_minor, amount_complete, file_path, status)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (asset_id, workspace_id, case_id, kind, Path(upload_path).name,
                 parsed.sha256, parsed.byte_size, now, PARSER_VERSION, scope_note,
                 f"application/{parsed.container}",
                 json.dumps([s.name for s in parsed.sheets]), detail_rows,
                 parse_error_rows, declared_total_minor, parsed_total, amount_complete,
                 rel_path, OBJECT_CONFIRMED))
            if parsed.warnings:
                self._audit(actor_id, "import_warnings", case_id,
                            detail={"asset_id": asset_id, "warnings": parsed.warnings})
            self._audit(actor_id, "import_completed", case_id,
                        detail={"asset_id": asset_id, "kind": kind,
                                "detail_rows": detail_rows,
                                "parse_error_rows": parse_error_rows})
        projection = self.get_asset(asset_id)
        projection["parse_errors"] = parse_errors[:100]
        projection["structure_reused"] = structure["reusable_confirmed"]
        projection["source_total_mismatch"] = bool(
            declared_total_minor is not None and declared_total_minor != parsed_total)
        return projection

    def _store_source_row(self, asset_id, case_id, sheet, row_number, kind, row, status,
                          error) -> None:
        self.db.conn.execute(
            "INSERT INTO source_rows (asset_id, case_id, sheet, row_number, kind, payload,"
            " parse_status, parse_error) VALUES (?,?,?,?,?,?,?,?)",
            (asset_id, case_id, sheet, row_number, kind,
             json.dumps(row, ensure_ascii=False), status, error))

    def _store_record(self, case_id, workspace_id, asset_id, kind, rec) -> None:
        c = self.db.conn
        if kind == "trips":
            c.execute("INSERT OR REPLACE INTO trips (case_id, trip_id, carrier_id, route_id,"
                      " vehicle_class, service_leg_id, departed_at, execution_status,"
                      " order_ids, asset_id, row_number) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      (case_id, rec["trip_id"], rec["carrier_id"], rec["route_id"],
                       rec["vehicle_class"], rec["service_leg_id"], rec["departed_at"],
                       rec["execution_status"], json.dumps(rec["order_ids"]), asset_id,
                       rec["row_number"]))
        elif kind == "bill":
            c.execute("INSERT OR REPLACE INTO bill_lines (case_id, line_id, carrier_id,"
                      " trip_ref, service_leg_id, charge_code, occurrence_id, amount_minor,"
                      " currency, amount_basis, reversal_of, asset_id, row_number)"
                      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (case_id, rec["line_id"], rec["carrier_id"], rec["trip_ref"],
                       rec["service_leg_id"], rec["charge_code"], rec["occurrence_id"],
                       rec["amount_minor"], rec["currency"], rec["amount_basis"],
                       rec["reversal_of"], asset_id, rec["row_number"]))
        elif kind == "rates":
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            c.execute("INSERT OR REPLACE INTO rate_rules (id, workspace_id, case_id, rule_id,"
                      " version, carrier_id, route_id, vehicle_class, charge_code, currency,"
                      " amount_basis, effective_from, effective_to, formula, rate_minor,"
                      " free_seconds, block_seconds, cap_minor, confirmed, confirmation_ref,"
                      " source_refs, created_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,"
                      "?,?,?,?,?,?,?,?,?)",
                      (f"{case_id}-{rec['rule_id']}-v{rec['version']}", workspace_id, case_id,
                       rec["rule_id"], rec["version"], rec["carrier_id"], rec["route_id"],
                       rec["vehicle_class"], rec["charge_code"], rec["currency"],
                       rec["amount_basis"], rec["effective_from"], rec["effective_to"],
                       rec["formula"], rec["rate_minor"], rec["free_seconds"],
                       rec["block_seconds"], rec["cap_minor"], 0, None,
                       json.dumps(rec["source_refs"]), now, "DRAFT"))
        elif kind == "waiting":
            c.execute("INSERT OR REPLACE INTO evidence_links (id, case_id, kind, trip_id,"
                      " occurrence_id, state, content_digest, amount_minor, currency,"
                      " amount_basis, elapsed_seconds, file_ref, reviewer_ref, asset_id,"
                      " row_number, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (f"WAIT-{case_id}-{rec['trip_id']}-{rec['occurrence_id']}", case_id,
                       "WAIT", rec["trip_id"], rec["occurrence_id"],
                       "CONFLICT" if rec["time_inverted"] else
                       ("VERIFIED" if rec["time_evidence_verified"] else "MISSING"),
                       None, None, None, None, rec["elapsed_seconds"], rec["file_ref"],
                       None, asset_id, rec["row_number"], None))
        elif kind == "receipts":
            verified = rec["verified_status"] == "VERIFIED"
            digest = canonical_hash({"receipt_id": rec["receipt_id"],
                                     "amount_minor": rec["amount_minor"],
                                     "file_ref": rec["file_ref"]})
            c.execute("INSERT OR REPLACE INTO evidence_links (id, case_id, kind, trip_id,"
                      " occurrence_id, state, content_digest, amount_minor, currency,"
                      " amount_basis, elapsed_seconds, file_ref, reviewer_ref, asset_id,"
                      " row_number, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (f"RCP-{case_id}-{rec['receipt_id']}", case_id, "RECEIPT",
                       rec["trip_id"], rec["occurrence_id"],
                       "VERIFIED" if verified else "MISSING", digest, rec["amount_minor"],
                       rec["currency"], rec["amount_basis"], None, rec["file_ref"], None,
                       asset_id, rec["row_number"], None))
        elif kind == "pod":
            state = rec["verified_status"] if rec["verified_status"] in (
                "VERIFIED", "MISSING", "CONFLICT") else "MISSING"
            c.execute("INSERT OR REPLACE INTO evidence_links (id, case_id, kind, trip_id,"
                      " occurrence_id, state, content_digest, amount_minor, currency,"
                      " amount_basis, elapsed_seconds, file_ref, reviewer_ref, asset_id,"
                      " row_number, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (f"POD-{case_id}-{rec['evidence_id']}", case_id, "POD",
                       rec["trip_id"], rec["occurrence_id"], state, None, None, None, None,
                       None, rec["file_ref"], rec["reviewer_ref"], asset_id,
                       rec["row_number"], None))
        elif kind == "history_trips":
            c.execute("INSERT OR REPLACE INTO trips (case_id, trip_id, carrier_id, route_id,"
                      " vehicle_class, service_leg_id, departed_at, execution_status,"
                      " order_ids, asset_id, row_number) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      (f"{case_id}::history", rec["trip_id"], rec["carrier_id"],
                       rec["route_id"], rec["vehicle_class"], rec["service_leg_id"],
                       rec["departed_at"], rec["execution_status"],
                       json.dumps(rec["order_ids"]), asset_id, rec["row_number"]))

    # ---- 查询 ----
    def _asset_projection(self, row: dict, reimported: bool = False) -> dict:
        return {
            "schema_version": "0.1.0", "asset_id": row["id"],
            "workspace_id": row["workspace_id"], "case_id": row["case_id"],
            "kind": row["kind"], "original_name": row["original_name"],
            "sha256": row["sha256"], "byte_size": row["byte_size"],
            "imported_at": row["imported_at"], "parser_version": row["parser_version"],
            "scope_note": row["scope_note"], "mime_type": row["mime_type"],
            "selected_sheets": json.loads(row["selected_sheets"]),
            "detail_rows": row["detail_rows"], "parse_error_rows": row["parse_error_rows"],
            "declared_total_minor": row["declared_total_minor"],
            "parsed_total_minor": row["parsed_total_minor"],
            "amount_complete": bool(row["amount_complete"]),
            "file_path": row["file_path"], "reimported": reimported,
        }

    def get_asset(self, asset_id: str) -> dict:
        row = self.db.conn.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        if row is None:
            raise NotFound("asset not found")
        return self._asset_projection(dict(row))

    def inspect_asset(self, asset_id: str, offset: int = 0, limit: int = 20) -> dict:
        asset = self.get_asset(asset_id)
        rows = self.db.conn.execute(
            "SELECT sheet, row_number, parse_status, parse_error, payload FROM source_rows"
            " WHERE asset_id=? ORDER BY row_number LIMIT ? OFFSET ?",
            (asset_id, limit, offset)).fetchall()
        sample = []
        for r in rows:
            item = {"sheet": r["sheet"], "row_number": r["row_number"],
                    "parse_status": r["parse_status"]}
            if r["parse_error"]:
                item["parse_error"] = r["parse_error"]
            payload = json.loads(r["payload"])
            # 脱敏样例：只回列名与截断值（§17.1 freight_inspect_asset）
            item["sample"] = {k: (v[:8] + "…" if isinstance(v, str) and len(v) > 12 else v)
                              for k, v in list(payload.items())[:12]}
            sample.append(item)
        asset["rows_sample"] = sample
        asset["warnings"] = []
        return asset

    def case_amount_complete(self, case_id: str) -> bool:
        rows = self.db.conn.execute(
            "SELECT amount_complete, declared_total_minor FROM assets WHERE case_id=?",
            (case_id,)).fetchall()
        return all(r["amount_complete"] for r in rows)
