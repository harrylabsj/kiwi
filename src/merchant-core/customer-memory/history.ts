/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 客户历史检索（设计 v1.1 §11 / M3-3）。
 *
 * 先做硬过滤（merchant/subject/grant/epoch/未封存/未过期），再用 FTS5
 * trigram 做中文子串检索（不足 3 字回退 LIKE）。每次最多 5 片段、正文合计
 * 不超过 2000 字；查询 ≤256 字；游标 5 分钟且绑定 grant/query。
 * 检索不可用返回 `unavailable`，不能伪装成 `no_match`。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { contentDigest } from "../../negotiation/jcs.js";
import type { ActorContext } from "../context-governance/actor-context.js";
import { hasCapability } from "../context-governance/actor-context.js";
import { DataUseGrantStore } from "../context-governance/data-use-grant.js";
import { GOVERNANCE_POLICY_VERSION } from "../context-governance/types.js";
import { inImmediateTransaction } from "../storage/transaction.js";
import {
  CustomerMemoryError,
  type HistoryHit,
  type HistorySearchResult,
} from "./types.js";

const MAX_QUERY_CHARS = 256;
const MAX_HITS = 5;
const MAX_HIT_TEXT_CHARS = 2_000;
const CURSOR_TTL_MS = 5 * 60 * 1000;

function text(value: string, field: string, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new CustomerMemoryError("validation", `${field}_invalid`, `${field} 必须是 1..${max} 字符`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CustomerMemoryError("validation", `${field}_invalid`, `${field} 含控制字符`);
  }
  return value;
}

function nowUtc(now: () => string): string {
  const ms = Date.parse(now());
  if (!Number.isFinite(ms)) {
    throw new CustomerMemoryError("validation", "now_invalid", "时钟输出必须是可解析的 RFC3339 时间");
  }
  return new Date(ms).toISOString();
}

function requireActor(actor: ActorContext, merchantId: string): void {
  if (actor.merchant_id !== merchantId) {
    throw new CustomerMemoryError("access_denied", "actor_merchant_mismatch", "ActorContext 与商家作用域不一致");
  }
  if (actor.policy_version !== GOVERNANCE_POLICY_VERSION) {
    throw new CustomerMemoryError("validation", "policy_version_mismatch", "治理策略版本不一致");
  }
  if (!hasCapability(actor, "customer:self") && !hasCapability(actor, "memory:read")) {
    throw new CustomerMemoryError("access_denied", "capability_missing", "缺少 customer:self/memory:read");
  }
}

function ftsQuery(query: string): string {
  // trigram 查询用引号包裹，内部引号双写，避免 FTS 语法注入。
  return `"${query.replaceAll('"', '""')}"`;
}

function escapeLike(query: string): string {
  return query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export class HistorySearchService {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly grants: DataUseGrantStore;

  constructor(options: { db: DatabaseSync; now: () => string }) {
    this.db = options.db;
    this.now = options.now;
    this.grants = new DataUseGrantStore({ db: options.db, now: options.now });
  }

  /** 索引历史投影（由 worker/系统调用）；必须仍是历史语义（is_current=false）。 */
  indexHistoryDocument(input: {
    merchant_id: string;
    subject_id: string;
    kind: string;
    sku?: string;
    occurred_at: string;
    source_version: number;
    text: string;
    grant_id: string;
    erase_scope_id: string;
    is_current?: boolean;
  }): string {
    const merchantId = text(input.merchant_id, "merchant_id");
    const subjectId = text(input.subject_id, "subject_id");
    if (input.is_current === true) {
      throw new CustomerMemoryError("validation", "history_current_rejected", "历史索引不能标记为当前事实");
    }
    if (!Number.isSafeInteger(input.source_version) || input.source_version < 1) {
      throw new CustomerMemoryError("validation", "source_version_invalid", "source_version 必须是正整数");
    }
    const body = text(input.text, "text", 20_000);
    const grant = this.grants.getActiveGrant({
      merchant_id: merchantId,
      subject_id: subjectId,
      purpose: "history_recall",
      resource_scope_id: input.erase_scope_id,
    });
    if (grant === undefined) {
      throw new CustomerMemoryError("grant_unavailable", "grant_not_active", "缺少历史检索授权");
    }
    const stamp = nowUtc(this.now);
    const documentId = `hist_${randomUUID()}`;
    return inImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO history_index
            (document_id, merchant_id, subject_id, kind, sku, occurred_at, source_version,
             is_current, text, grant_id, grant_epoch, erase_scope_id, purge_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          documentId,
          merchantId,
          subjectId,
          text(input.kind, "kind", 64),
          input.sku === undefined ? null : text(input.sku, "sku", 128),
          text(input.occurred_at, "occurred_at", 64),
          input.source_version,
          body,
          grant.grant_id,
          grant.grant_epoch,
          text(input.erase_scope_id, "erase_scope_id"),
          new Date(Date.parse(stamp) + 90 * 24 * 60 * 60 * 1000).toISOString(),
          stamp,
        );
      this.db
        .prepare(
          "INSERT INTO history_fts (document_id, merchant_id, subject_id, text) VALUES (?, ?, ?, ?)",
        )
        .run(documentId, merchantId, subjectId, body);
      return documentId;
    });
  }

  search(input: {
    merchant_id: string;
    actor: ActorContext;
    subject_id: string;
    resource_scope_id: string;
    query: string;
    cursor?: string;
    limit?: number;
  }): HistorySearchResult {
    const merchantId = text(input.merchant_id, "merchant_id");
    requireActor(input.actor, merchantId);
    const subjectId = text(input.subject_id, "subject_id");
    const scopeId = text(input.resource_scope_id, "resource_scope_id");
    const query = text(input.query, "query", MAX_QUERY_CHARS);
    const limit = input.limit ?? MAX_HITS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HITS) {
      throw new CustomerMemoryError("validation", "limit_invalid", "limit 必须在 1..5");
    }
    const grant = this.grants.getActiveGrant({
      merchant_id: merchantId,
      subject_id: subjectId,
      purpose: "history_recall",
      resource_scope_id: scopeId,
    });
    if (grant === undefined) {
      throw new CustomerMemoryError("grant_unavailable", "grant_not_active", "缺少历史检索授权");
    }
    const stamp = nowUtc(this.now);
    const queryDigest = contentDigest({ query, subject: subjectId, scope: scopeId });
    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = this.readCursor(text(input.cursor, "cursor"));
      if (
        cursor === undefined ||
        cursor.merchant_id !== merchantId ||
        cursor.subject_id !== subjectId ||
        cursor.grant_id !== grant.grant_id ||
        cursor.grant_epoch !== grant.grant_epoch ||
        cursor.query_digest !== queryDigest ||
        cursor.expires_at <= stamp
      ) {
        throw new CustomerMemoryError("validation", "cursor_stale", "游标已失效；请重新查询");
      }
      offset = cursor.offset;
    }
    try {
      const useFts = [...query].length >= 3;
      const rows = (
        useFts
          ? this.db
              .prepare(
                `SELECT h.document_id, h.source_version, h.kind, h.sku, h.occurred_at, h.text
                   FROM history_index h
                   JOIN history_fts ON history_fts.document_id = h.document_id
                  WHERE h.merchant_id = ? AND h.subject_id = ?
                    AND h.grant_id = ? AND h.grant_epoch = ?
                    AND h.purge_at > ?
                    AND NOT EXISTS (
                      SELECT 1 FROM data_scopes ds
                       WHERE ds.merchant_id = h.merchant_id
                         AND ds.erase_scope_id = h.erase_scope_id AND ds.state = 'SEALED')
                    AND history_fts MATCH ?
                  ORDER BY h.occurred_at DESC, h.document_id ASC
                  LIMIT ? OFFSET ?`,
              )
              .all(merchantId, subjectId, grant.grant_id, grant.grant_epoch, stamp, ftsQuery(query), limit + 1, offset)
          : this.db
              .prepare(
                `SELECT h.document_id, h.source_version, h.kind, h.sku, h.occurred_at, h.text
                   FROM history_index h
                  WHERE h.merchant_id = ? AND h.subject_id = ?
                    AND h.grant_id = ? AND h.grant_epoch = ?
                    AND h.purge_at > ?
                    AND NOT EXISTS (
                      SELECT 1 FROM data_scopes ds
                       WHERE ds.merchant_id = h.merchant_id
                         AND ds.erase_scope_id = h.erase_scope_id AND ds.state = 'SEALED')
                    AND h.text LIKE ? ESCAPE '\\'
                  ORDER BY h.occurred_at DESC, h.document_id ASC
                  LIMIT ? OFFSET ?`,
              )
              .all(
                merchantId,
                subjectId,
                grant.grant_id,
                grant.grant_epoch,
                stamp,
                `%${escapeLike(query)}%`,
                limit + 1,
                offset,
              )
      ) as unknown as Array<{
        document_id: string;
        source_version: number;
        kind: string;
        sku: string | null;
        occurred_at: string;
        text: string;
      }>;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      let budget = MAX_HIT_TEXT_CHARS;
      const hits: HistoryHit[] = [];
      for (const row of page) {
        const snippet = row.text.slice(0, 400);
        if (snippet.length > budget) break;
        budget -= snippet.length;
        hits.push({
          document_ref: row.document_id,
          source_version: row.source_version,
          historical: true,
          is_current: false,
          kind: row.kind,
          ...(row.sku !== null ? { sku: row.sku } : {}),
          occurred_at: row.occurred_at,
          snippet,
        });
      }
      if (hits.length === 0) return { status: "no_match", hits: [] };
      let nextCursor: string | undefined;
      if (hasMore) {
        nextCursor = this.createCursor({
          merchantId,
          subjectId,
          grantId: grant.grant_id,
          grantEpoch: grant.grant_epoch,
          queryDigest,
          offset: offset + hits.length,
          stamp,
        });
      }
      return { status: "ok", hits, ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}) };
    } catch (err) {
      // 不向调用方泄露 SQL/路径；错误类别保留在 reason 供诊断/告警。
      return {
        status: "unavailable",
        reason: err instanceof Error ? err.message.slice(0, 200) : "history_store_error",
      };
    }
  }

  private createCursor(input: {
    merchantId: string;
    subjectId: string;
    grantId: string;
    grantEpoch: number;
    queryDigest: string;
    offset: number;
    stamp: string;
  }): string {
    const cursorId = `hcur_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO history_cursors
          (cursor_id, merchant_id, subject_id, grant_id, grant_epoch, query_digest,
           offset, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cursorId,
        input.merchantId,
        input.subjectId,
        input.grantId,
        input.grantEpoch,
        input.queryDigest,
        input.offset,
        new Date(Date.parse(input.stamp) + CURSOR_TTL_MS).toISOString(),
        input.stamp,
      );
    return cursorId;
  }

  private readCursor(cursorId: string): {
    merchant_id: string;
    subject_id: string;
    grant_id: string;
    grant_epoch: number;
    query_digest: string;
    offset: number;
    expires_at: string;
  } | undefined {
    return this.db
      .prepare("SELECT * FROM history_cursors WHERE cursor_id = ?")
      .get(cursorId) as unknown as
      | {
          merchant_id: string;
          subject_id: string;
          grant_id: string;
          grant_epoch: number;
          query_digest: string;
          offset: number;
          expires_at: string;
        }
      | undefined;
  }
}
