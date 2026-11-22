import type { DatabaseSync } from "node:sqlite";

export class ProcurementStore {
  constructor(private readonly db: DatabaseSync, private readonly transact: <T>(callback: () => T) => T) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_company_procurement_versions (
        owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY (owner, kind, id, revision)
      );
      CREATE TABLE IF NOT EXISTS mcp_company_procurement_requests (
        owner TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL,
        digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (owner, operation, request_id)
      );
    `);
  }

  actions<T>(owner: string, caseId: string): T[] {
    return this.db.prepare(`SELECT payload FROM (
      SELECT id, payload, ROW_NUMBER() OVER (PARTITION BY id ORDER BY revision DESC) AS rank
      FROM mcp_company_procurement_versions WHERE owner=? AND kind='action' AND json_extract(payload, '$.case_id')=?
    ) WHERE rank=1 ORDER BY id`).all(owner, caseId)
      .map(row => JSON.parse(String(row.payload)) as T);
  }

  countActions(owner: string, caseId: string, sourceKey: string, operation: string, resumingId?: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT payload, ROW_NUMBER() OVER (PARTITION BY id ORDER BY revision DESC) AS rank
      FROM mcp_company_procurement_versions WHERE owner=? AND kind='action' AND id IS NOT ?
      AND json_extract(payload, '$.case_id')=? AND json_extract(payload, '$.operation')=?
      AND json_extract(payload, '$.payload.source_key')=?
    ) WHERE rank=1 AND json_extract(payload, '$.status') IN ('IN_FLIGHT', 'UNKNOWN', 'DONE')`)
      .get(owner, resumingId ?? null, caseId, operation, sourceKey);
    return Number(row?.count ?? 0);
  }

  transaction<T>(callback: () => T): T { return this.transact(callback); }

  read<T>(owner: string, kind: string, id: string, revision?: number): T | undefined {
    const row = this.db.prepare(`SELECT payload FROM mcp_company_procurement_versions
      WHERE owner=? AND kind=? AND id=? AND (? IS NULL OR revision=?) ORDER BY revision DESC LIMIT 1`)
      .get(owner, kind, id, revision ?? null, revision ?? null);
    return row === undefined ? undefined : JSON.parse(String(row.payload)) as T;
  }

  write(owner: string, kind: string, record: { id: string; revision: number }): void {
    this.db.prepare("INSERT INTO mcp_company_procurement_versions VALUES (?, ?, ?, ?, ?)")
      .run(owner, kind, record.id, record.revision, JSON.stringify(record));
  }

  list<T>(owner: string, kind: string, limit: number, offset: number): T[] {
    return this.db.prepare(`SELECT payload FROM (
      SELECT id, payload, ROW_NUMBER() OVER (PARTITION BY id ORDER BY revision DESC) AS rank
      FROM mcp_company_procurement_versions WHERE owner=? AND kind=?
    ) WHERE rank=1 ORDER BY id DESC LIMIT ? OFFSET ?`).all(owner, kind, limit, offset)
      .map(row => JSON.parse(String(row.payload)) as T);
  }

  history(owner: string, kind: string, id: string) {
    return this.db.prepare(`SELECT revision FROM mcp_company_procurement_versions
      WHERE owner=? AND kind=? AND id=? ORDER BY revision DESC`).all(owner, kind, id).map(row => Number(row.revision));
  }

  request<T>(owner: string, operation: string, id: string): { digest: string; value: T } | undefined {
    const row = this.db.prepare("SELECT digest, payload FROM mcp_company_procurement_requests WHERE owner=? AND operation=? AND request_id=?")
      .get(owner, operation, id);
    return row && { digest: String(row.digest), value: JSON.parse(String(row.payload)) as T };
  }

  saveRequest(owner: string, operation: string, id: string, digest: string, value: unknown): void {
    this.db.prepare(`INSERT INTO mcp_company_procurement_requests VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner, operation, request_id) DO UPDATE SET payload=excluded.payload WHERE digest=excluded.digest`)
      .run(owner, operation, id, digest, JSON.stringify(value));
  }
}
