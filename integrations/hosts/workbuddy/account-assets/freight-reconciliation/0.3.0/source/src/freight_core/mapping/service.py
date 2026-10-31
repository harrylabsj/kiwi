"""映射模板（MappingProfile，§6.2）：按主体/承运商/表结构签名/版本存储。

- 关键列改名、类型或单位变化 → 新 structure_digest → 必须重新人工确认。
- 增加列可告知后复用；关键列不凭置信度自动启用。
"""
from __future__ import annotations

from ..domain import OBJECT_CONFIRMED, OBJECT_DRAFT, OBJECT_SUPERSEDED
from ..errors import InvalidInput, NotFound, VersionConflict
from ..money import canonical_hash

REQUIRED_FIELDS = {
    "trips": ["trip_id", "carrier_id", "route_id", "vehicle_class", "service_leg_id",
              "departed_at", "execution_status"],
    "history_trips": ["trip_id", "carrier_id", "route_id", "vehicle_class",
                      "service_leg_id", "departed_at", "execution_status"],
    "bill": ["line_id", "carrier_id", "trip_ref", "service_leg_id", "charge_code",
             "occurrence_id", "amount_minor", "currency", "amount_basis"],
    "rates": ["rule_id", "version", "carrier_id", "route_id", "vehicle_class",
              "charge_code", "currency", "amount_basis", "effective_from",
              "effective_to", "formula", "rate_minor"],
    "waiting": ["occurrence_id", "trip_id", "verified_status"],
    "receipts": ["receipt_id", "trip_id", "occurrence_id", "amount_minor", "currency",
                 "amount_basis", "verified_status"],
    "pod": ["evidence_id", "trip_id", "evidence_type", "verified_status"],
}


def structure_digest(kind: str, header: list[str]) -> str:
    return canonical_hash({"kind": kind, "header": list(header)})


class MappingService:
    def __init__(self, db):
        self.db = db

    def evaluate_structure(self, case_id: str, kind: str, header: list[str]) -> dict:
        """对比现有已确认模板，判断该结构是否可直接复用。"""
        missing = [f for f in REQUIRED_FIELDS.get(kind, []) if f not in header]
        if kind == "waiting" and not (("arrived_at" in header and "departed_at" in header)
                                      or "elapsed_seconds" in header):
            missing.append("arrived_at+departed_at 或 elapsed_seconds（二选一）")
        digest = structure_digest(kind, header)
        row = self.db.conn.execute(
            "SELECT * FROM mapping_versions WHERE case_id=? AND kind=? AND status=? "
            "ORDER BY version DESC LIMIT 1", (case_id, kind, OBJECT_CONFIRMED)).fetchone()
        result = {"kind": kind, "structure_digest": digest, "missing_required": missing,
                  "reusable_confirmed": False, "mapping": None}
        if row is not None:
            result["mapping"] = {"mapping_id": row["mapping_id"], "version": row["version"],
                                 "structure_digest": row["structure_digest"]}
            if row["structure_digest"] == digest and not missing:
                result["reusable_confirmed"] = True
        return result

    def prepare(self, workspace_id: str, case_id: str, kind: str, header: list[str],
                fields: dict | None = None, expected_revision: int | None = None) -> dict:
        """模型/用户可调用：产出待确认的映射草稿（不激活）。"""
        if kind not in REQUIRED_FIELDS:
            raise InvalidInput(f"unknown asset kind {kind}")
        missing = [f for f in REQUIRED_FIELDS[kind] if f not in (fields or {}).values()
                   and f not in header]
        digest = structure_digest(kind, header)
        cur = self.db.conn.execute(
            "SELECT COALESCE(MAX(version),0)+1 FROM mapping_versions WHERE case_id=? AND kind=?",
            (case_id, kind)).fetchone()
        version = cur[0]
        mapping_id = f"MAP-{case_id}-{kind}"
        mid = f"{mapping_id}#v{version}"
        import datetime
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        doc = {"schema_version": "0.1.0", "mapping_id": mapping_id, "version": version,
               "workspace_id": workspace_id,
               "structure_digest": digest,
               "fields": fields or {h: h for h in header if h},
               "confirmed": False, "confirmation_ref": None}
        self.db.conn.execute(
            "INSERT INTO mapping_versions (id, workspace_id, case_id, mapping_id, version,"
            " kind, structure_digest, fields, confirmed, confirmation_ref, created_at, status)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (mid, workspace_id, case_id, mapping_id, version, kind, digest,
             __import__("json").dumps(doc["fields"], ensure_ascii=False), 0, None, now,
             OBJECT_DRAFT))
        self.db.conn.commit()
        doc["id"] = mid
        doc["missing_required"] = missing
        return doc

    def confirm(self, mapping_version_id: str, actor_id: str,
                confirmation_ref: str) -> dict:
        """管理页专用：激活映射版本，旧版本转 SUPERSEDED。"""
        row = self.db.conn.execute(
            "SELECT * FROM mapping_versions WHERE id=?", (mapping_version_id,)).fetchone()
        if row is None:
            raise NotFound("mapping version not found")
        if row["status"] == OBJECT_CONFIRMED:
            return {"mapping_id": row["mapping_id"], "version": row["version"],
                    "confirmation_ref": row["confirmation_ref"]}  # 幂等：返回原结果
        import datetime
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.db.conn.execute(
            "UPDATE mapping_versions SET status=? WHERE case_id=? AND kind=? AND status=?",
            (OBJECT_SUPERSEDED, row["case_id"], row["kind"], OBJECT_CONFIRMED))
        self.db.conn.execute(
            "UPDATE mapping_versions SET status=?, confirmed=1, confirmation_ref=? WHERE id=?",
            (OBJECT_CONFIRMED, confirmation_ref, mapping_version_id))
        self.db.conn.execute(
            "INSERT INTO audit_events (at, actor_id, event, case_id, detail) VALUES (?,?,?,?,?)",
            (now, actor_id, "mapping_confirmed", row["case_id"],
             __import__("json").dumps({"mapping": mapping_version_id}, ensure_ascii=False)))
        self.db.conn.commit()
        return {"mapping_id": row["mapping_id"], "version": row["version"],
                "confirmation_ref": confirmation_ref}

    def get_confirmed(self, case_id: str, kind: str) -> dict | None:
        row = self.db.conn.execute(
            "SELECT * FROM mapping_versions WHERE case_id=? AND kind=? AND status=? "
            "ORDER BY version DESC LIMIT 1", (case_id, kind, OBJECT_CONFIRMED)).fetchone()
        if row is None:
            return None
        import json
        return {"mapping_id": row["mapping_id"], "version": row["version"],
                "structure_digest": row["structure_digest"],
                "fields": json.loads(row["fields"]), "id": row["id"]}
