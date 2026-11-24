/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertVerifiedActor, type VerifiedActorContext } from "../../merchant/application/actor.js";
import { migrateModuleSchema } from "../migrations/runner.js";
import { inImmediateTransaction } from "../storage/transaction.js";

const DAY = 86400_000;
const MAX_ACTIVE_SESSIONS = 1000;
const MAX_CASES_PER_SESSION = 20;
const PAGE_SIZE = 40;
const MAX_REPLY_LENGTH = 2000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SKU = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const SUPPORT_SCHEMA = {
  module: "manual-support",
  ledgerTable: "support_schema_migrations",
  migrations: { 1: `
    CREATE TABLE support_sessions (
      tenant TEXT NOT NULL, id TEXT NOT NULL, token_digest TEXT UNIQUE,
      idle_until INTEGER NOT NULL, absolute_until INTEGER NOT NULL,
      access_revision INTEGER NOT NULL DEFAULT 1, control_epoch INTEGER NOT NULL DEFAULT 1,
      assigned_to TEXT, revoked_at INTEGER,
      PRIMARY KEY (tenant, id)
    );
    CREATE INDEX support_session_active ON support_sessions (tenant, idle_until, absolute_until) WHERE revoked_at IS NULL;
    CREATE TABLE support_cases (
      tenant TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL, input_digest TEXT NOT NULL, message_id TEXT NOT NULL,
      description TEXT NOT NULL, sku TEXT,
      status TEXT NOT NULL CHECK (status IN ('WAITING_MERCHANT', 'IN_PROGRESS', 'RESOLVED')),
      assignee TEXT, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id), UNIQUE (tenant, session_id, client_message_id),
      FOREIGN KEY (tenant, session_id) REFERENCES support_sessions (tenant, id)
    );
    CREATE INDEX support_case_queue ON support_cases (tenant, updated_at DESC);
    CREATE TABLE support_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      tenant TEXT NOT NULL, session_id TEXT NOT NULL, case_id TEXT NOT NULL,
      access_revision INTEGER NOT NULL, control_epoch INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('case_receipt', 'claimed', 'human_reply', 'resolved')),
      body TEXT, actor_id TEXT, created_at INTEGER NOT NULL,
      FOREIGN KEY (tenant, session_id) REFERENCES support_sessions (tenant, id),
      FOREIGN KEY (tenant, case_id) REFERENCES support_cases (tenant, id)
    );
    CREATE INDEX support_session_feed ON support_events (tenant, session_id, access_revision, seq);
    CREATE INDEX support_case_events ON support_events (tenant, case_id, seq);
  ` },
} as const;

type Status = "WAITING_MERCHANT" | "IN_PROGRESS" | "RESOLVED";
type EventKind = "case_receipt" | "claimed" | "human_reply" | "resolved";
interface SessionRow {
  id: string; access_revision: number; control_epoch: number; assigned_to: string | null;
  revoked_at: number | null; idle_until: number; absolute_until: number;
}
interface CaseRow {
  id: string; session_id: string; message_id: string; input_digest: string; status: Status;
  revision: number; assignee: string | null; updated_at: number; sku: string | null; description: string;
}
interface EventRow {
  seq: number; id: string; case_id: string; kind: EventKind; body: string | null; created_at: number; actor_id: string | null;
}

export class ManualSupportError extends Error {
  constructor(readonly code: "validation" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "capacity" | "unavailable") {
    super(code);
  }
}

function validatedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max || value.includes("\0")) {
    throw new ManualSupportError("validation");
  }
  return value.trim();
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (time: number) => new Date(time).toISOString();

/** 单商家、人工-only 的受理与回访。只有当前实例所有权持有者可落库或授权回访读取。 */
export class ManualSupportService {
  private readonly tenant: string;
  private readonly now: () => number;
  private readonly assertOwner: () => void;

  constructor(private readonly db: DatabaseSync, options: {
    merchantId: string;
    /** 在当前 state.sqlite 的立即事务内复核真实租约/fencing；禁止使用公网适配器连接。 */
    assertOwner: () => void;
    now?: () => number;
  }) {
    this.tenant = validatedText(options.merchantId, 200);
    this.now = options.now ?? Date.now;
    this.assertOwner = options.assertOwner;
    this.underOwner(() => migrateModuleSchema(db, SUPPORT_SCHEMA));
  }

  private underOwner<T>(work: () => T): T {
    return inImmediateTransaction(this.db, () => {
      this.checkOwner();
      const result = work();
      this.checkOwner();
      return result;
    });
  }

  private checkOwner(): void {
    try { this.assertOwner(); } catch { throw new ManualSupportError("unavailable"); }
  }

  private staff(actor: VerifiedActorContext): VerifiedActorContext {
    const verified = assertVerifiedActor(actor, new Date(this.now()));
    // M0 私有预览仅让已验证 owner 担任坐席，暂不向通用 operator 扩权。
    if (verified.role !== "owner" || verified.authMethod !== "admin-session" || verified.merchantId !== this.tenant) {
      throw new ManualSupportError("forbidden");
    }
    return verified;
  }

  private sessionByToken(token: string | undefined): SessionRow | undefined {
    if (token === undefined || !TOKEN.test(token)) return undefined;
    const time = this.now();
    return this.db.prepare(`SELECT * FROM support_sessions WHERE tenant=? AND token_digest=? AND revoked_at IS NULL
      AND idle_until>? AND absolute_until>?`).get(this.tenant, sha(token), time, time) as SessionRow | undefined;
  }

  private touch(row: SessionRow): void {
    this.db.prepare("UPDATE support_sessions SET idle_until=? WHERE tenant=? AND id=?")
      .run(Math.min(row.absolute_until, this.now() + 30 * DAY), this.tenant, row.id);
  }

  private requireSession(token: string | undefined): SessionRow {
    const row = this.sessionByToken(token);
    if (row === undefined) throw new ManualSupportError("unauthorized");
    this.touch(row);
    return row;
  }

  begin(token?: string, admitNew?: () => void): { token?: string; reset: boolean } {
    return this.underOwner(() => {
      const row = this.sessionByToken(token);
      if (row !== undefined) { this.touch(row); return { reset: false }; }
      admitNew?.();
      const now = this.now();
      const { count } = this.db.prepare(`SELECT COUNT(*) AS count FROM support_sessions WHERE tenant=?
        AND revoked_at IS NULL AND idle_until>? AND absolute_until>?`).get(this.tenant, now, now) as { count: number };
      if (count >= MAX_ACTIVE_SESSIONS) throw new ManualSupportError("capacity");
      const fresh = randomBytes(32).toString("base64url");
      this.db.prepare(`INSERT INTO support_sessions (tenant, id, token_digest, idle_until, absolute_until) VALUES (?, ?, ?, ?, ?)`)
        .run(this.tenant, randomUUID(), sha(fresh), now + 30 * DAY, now + 90 * DAY);
      return { token: fresh, reset: token !== undefined };
    });
  }

  confirmCase(token: string | undefined, input: { client_message_id: string; description: string; sku?: string }) {
    return this.underOwner(() => {
      const session = this.requireSession(token); // 不允许过期凭证探测幂等结果。
      const description = validatedText(input.description, 2000);
      const sku = input.sku ?? null;
      if (!UUID.test(input.client_message_id) || (sku !== null && !SKU.test(sku))) throw new ManualSupportError("validation");
      const digest = sha(JSON.stringify([description, sku]));
      const existing = this.db.prepare("SELECT id, message_id, input_digest FROM support_cases WHERE tenant=? AND session_id=? AND client_message_id=?")
        .get(this.tenant, session.id, input.client_message_id) as Pick<CaseRow, "id" | "message_id" | "input_digest"> | undefined;
      if (existing !== undefined) {
        if (existing.input_digest !== digest) throw new ManualSupportError("conflict");
        return { accepted: true as const, message_id: existing.message_id };
      }
      const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM support_cases WHERE tenant=? AND session_id=?")
        .get(this.tenant, session.id) as { count: number };
      if (count >= MAX_CASES_PER_SESSION) throw new ManualSupportError("capacity");
      const id = `CS-${randomUUID()}`;
      const messageId = randomUUID();
      this.db.prepare(`INSERT INTO support_cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WAITING_MERCHANT', NULL, 1, ?)`)
        .run(this.tenant, id, session.id, input.client_message_id, digest, messageId, description, sku, this.now());
      this.append(session, id, "case_receipt", null, null);
      return { accepted: true as const, message_id: messageId };
    });
  }

  private append(session: SessionRow, id: string, kind: EventKind, body: string | null, actor: string | null): string {
    const event = randomUUID();
    this.db.prepare(`INSERT INTO support_events (id, tenant, session_id, case_id, access_revision, control_epoch, kind, body, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(event, this.tenant, session.id, id, session.access_revision, session.control_epoch,
      kind, body, actor, this.now());
    return event;
  }

  private requireCase(id: string, sessionId?: string): CaseRow {
    const row = (sessionId === undefined
      ? this.db.prepare("SELECT * FROM support_cases WHERE tenant=? AND id=?").get(this.tenant, id)
      : this.db.prepare("SELECT * FROM support_cases WHERE tenant=? AND id=? AND session_id=?").get(this.tenant, id, sessionId)) as CaseRow | undefined;
    if (row === undefined) throw new ManualSupportError("not_found");
    return row;
  }

  private caseView(row: CaseRow) {
    return { case_id: row.id, state: row.status, updated_at: iso(row.updated_at) };
  }

  ownCase(token: string | undefined, id: string) {
    return this.underOwner(() => this.caseView(this.requireCase(id, this.requireSession(token).id)));
  }

  private cursor(token: string, session: SessionRow, seq: number): string {
    const tag = createHmac("sha256", token).update(JSON.stringify([this.tenant, session.id, session.access_revision, seq]))
      .digest().subarray(0, 16).toString("hex");
    return `${seq}.${tag}`;
  }

  private position(token: string, session: SessionRow, cursor: string): number {
    const parts = /^(0|[1-9]\d{0,15})\.[a-f0-9]{32}$/.exec(cursor);
    if (parts === null) throw new ManualSupportError("validation");
    const seq = Number(parts[1]);
    if (!Number.isSafeInteger(seq) || !timingSafeEqual(Buffer.from(cursor), Buffer.from(this.cursor(token, session, seq)))) {
      throw new ManualSupportError("validation");
    }
    return seq;
  }

  updates(token: string | undefined, query: { after?: string; before?: string }) {
    return this.underOwner(() => {
      const session = this.requireSession(token);
      if (token === undefined || (query.after !== undefined && query.before !== undefined)) throw new ManualSupportError("validation");
      const after = query.after !== undefined;
      const position = this.position(token, session, query.after ?? query.before ?? this.cursor(token, session, Number.MAX_SAFE_INTEGER));
      const rows = this.db.prepare(`SELECT seq, id, case_id, kind, body, created_at FROM support_events
        WHERE tenant=? AND session_id=? AND access_revision=? AND seq ${after ? ">" : "<"} ?
        ORDER BY seq ${after ? "ASC" : "DESC"} LIMIT ?`).all(this.tenant, session.id, session.access_revision, position, PAGE_SIZE + 1) as unknown as EventRow[];
      const more = rows.length > PAGE_SIZE;
      const page = rows.slice(0, PAGE_SIZE);
      if (!after) page.reverse();
      const first = page[0];
      const last = page.at(-1);
      return {
        events: page.map(({ id, kind, case_id, created_at, body }) => ({ id, kind, case_id, occurred_at: iso(created_at), ...(body === null ? {} : { text: body }) })),
        next_cursor: this.cursor(token, session, last?.seq ?? (after ? position : 0)),
        previous_cursor: !after && more && first !== undefined ? this.cursor(token, session, first.seq) : null,
      };
    });
  }

  list(actor: VerifiedActorContext) {
    return this.underOwner(() => {
      this.staff(actor);
      const rows = this.db.prepare(`SELECT * FROM support_cases WHERE tenant=? ORDER BY
        CASE status WHEN 'WAITING_MERCHANT' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END, updated_at DESC, id LIMIT 100`)
        .all(this.tenant) as unknown as CaseRow[];
      return rows.map((row) => ({ ...this.caseView(row), revision: row.revision, sku: row.sku }));
    });
  }

  detail(actor: VerifiedActorContext, id: string) {
    return this.underOwner(() => {
      const staff = this.staff(actor);
      const row = this.requireCase(id);
      const session = this.getCaseSession(row);
      const replies = this.db.prepare(`SELECT id, kind, body, created_at FROM support_events
        WHERE tenant=? AND case_id=? AND kind IN ('human_reply', 'resolved')
        ORDER BY seq DESC LIMIT 40`).all(this.tenant, id) as unknown as Pick<EventRow, "id" | "kind" | "body" | "created_at">[];
      return { ...this.caseView(row), revision: row.revision, sku: row.sku, description: row.description,
        access_active: this.active(session), held_by_me: row.assignee === staff.actorId && session.assigned_to === staff.actorId,
        replies: replies.reverse().map(({ id, kind, body, created_at }) => ({ id, kind, text: body, saved_at: iso(created_at) })) };
    });
  }

  private getCaseSession(row: CaseRow): SessionRow {
    const result = this.db.prepare("SELECT * FROM support_sessions WHERE tenant=? AND id=?").get(this.tenant, row.session_id) as SessionRow | undefined;
    if (result === undefined) throw new ManualSupportError("unavailable");
    return result;
  }

  private active(session: SessionRow): boolean {
    return session.revoked_at === null && Math.min(session.idle_until, session.absolute_until) > this.now();
  }

  change(actor: VerifiedActorContext, id: string, expectedRevision: number,
    input: { kind: "claim" } | { kind: "revoke" } | { kind: "reply"; text: string } | { kind: "resolve"; text: string }) {
    return this.underOwner(() => {
      const staff = this.staff(actor);
      const row = this.requireCase(id);
      const session = this.getCaseSession(row);
      if (row.revision !== expectedRevision || !this.active(session)) throw new ManualSupportError("conflict");
      if (input.kind === "revoke") {
        this.db.prepare(`UPDATE support_sessions SET revoked_at=?, token_digest=NULL, access_revision=access_revision+1 WHERE tenant=? AND id=?`)
          .run(this.now(), this.tenant, session.id);
        // 撤销的是浏览器会话：同一会话所有工单的旧控制表单均失效，不自动结案。
        this.db.prepare("UPDATE support_cases SET revision=revision+1, updated_at=? WHERE tenant=? AND session_id=?")
          .run(this.now(), this.tenant, session.id);
        return { case_id: id, revision: row.revision + 1, access_revoked: true as const };
      }
      if (input.kind === "claim") {
        if (row.status !== "WAITING_MERCHANT" || (session.assigned_to !== null && session.assigned_to !== staff.actorId)) {
          throw new ManualSupportError("conflict");
        }
        if (session.assigned_to === null) {
          this.db.prepare("UPDATE support_sessions SET assigned_to=?, control_epoch=control_epoch+1 WHERE tenant=? AND id=?")
            .run(staff.actorId, this.tenant, session.id);
          session.control_epoch++;
        }
        this.db.prepare("UPDATE support_cases SET status='IN_PROGRESS', assignee=? WHERE tenant=? AND id=?")
          .run(staff.actorId, this.tenant, id);
        this.append(session, id, "claimed", null, staff.actorId);
      } else {
        if (row.status !== "IN_PROGRESS" || row.assignee !== staff.actorId || session.assigned_to !== staff.actorId) {
          throw new ManualSupportError("conflict");
        }
        const text = validatedText(input.text, MAX_REPLY_LENGTH);
        if (input.kind === "resolve") this.db.prepare("UPDATE support_cases SET status='RESOLVED' WHERE tenant=? AND id=?").run(this.tenant, id);
        this.append(session, id, input.kind === "reply" ? "human_reply" : "resolved", text, staff.actorId);
      }
      this.db.prepare("UPDATE support_cases SET revision=revision+1, updated_at=? WHERE tenant=? AND id=?")
        .run(this.now(), this.tenant, id);
      return { ...this.caseView(this.requireCase(id)), revision: row.revision + 1 };
    });
  }
}
