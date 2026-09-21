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
 * 管理草稿存储（BD 设计 §10.1 的导入草稿与策略草稿）。
 *
 * 私密边界（红线 6）：策略草稿的 **patch 原文**（可含底价/成本）只存这里的
 * 权威存储（state.sqlite，0600 数据目录）；API 响应、回执与日志只允许出现
 * `payload_digest` 与版本号——**任何端点都不得把 policy 草稿原文读出来**。
 * 商品表草稿是公开投影，原文可进响应。
 *
 * 生命周期：draft → committed（终态，不可复用）；同 payload 重复创建按
 * (merchant_id, kind, payload_digest, status='draft') 去重返回既有草稿。
 */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const DRAFT_SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_management_import_drafts (
  draft_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('products_import', 'policy_override')),
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  base_digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'committed')),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  UNIQUE (merchant_id, kind, payload_digest, status)
);
`;

export type DraftKind = "products_import" | "policy_override";

export interface ImportDraft {
  draft_id: string;
  kind: DraftKind;
  payload_digest: string;
  base_digest: string | null;
  status: "draft" | "committed";
  created_at: string;
  committed_at: string | null;
}

interface ImportRow {
  draft_id: string;
  merchant_id: string;
  kind: string;
  payload_json: string;
  payload_digest: string;
  base_digest: string | null;
  status: string;
  created_at: string;
  committed_at: string | null;
}

export class MerchantImportDraftStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now?: () => string }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec(DRAFT_SCHEMA);
  }

  /** 创建草稿；同商家同类型同内容的未提交草稿直接复用（幂等，不膨胀）。 */
  create(input: {
    merchantId: string;
    kind: DraftKind;
    payloadJson: string;
    payloadDigest: string;
    baseDigest?: string;
  }): { draftId: string; reused: boolean } {
    const existing = this.db
      .prepare(
        `SELECT draft_id FROM merchant_management_import_drafts
         WHERE merchant_id = ? AND kind = ? AND payload_digest = ? AND status = 'draft'`,
      )
      .get(input.merchantId, input.kind, input.payloadDigest) as
      | { draft_id: string }
      | undefined;
    if (existing !== undefined) {
      return { draftId: existing.draft_id, reused: true };
    }
    const draftId = `dft_${randomBytes(10).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO merchant_management_import_drafts
         (draft_id, merchant_id, kind, payload_json, payload_digest, base_digest, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`,
      )
      .run(
        draftId,
        input.merchantId,
        input.kind,
        input.payloadJson,
        input.payloadDigest,
        input.baseDigest ?? null,
        this.now(),
      );
    return { draftId, reused: false };
  }

  /** 取草稿（含原文——**只供提交路径在服务端使用**，绝不出 API 响应）。 */
  getPayload(
    merchantId: string,
    draftId: string,
  ): (ImportDraft & { payload_json: string }) | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM merchant_management_import_drafts WHERE draft_id = ? AND merchant_id = ?",
      )
      .get(draftId, merchantId) as unknown as ImportRow | undefined;
    if (row === undefined) return undefined;
    return {
      draft_id: row.draft_id,
      kind: row.kind as DraftKind,
      payload_digest: row.payload_digest,
      base_digest: row.base_digest,
      status: row.status === "committed" ? "committed" : "draft",
      created_at: row.created_at,
      committed_at: row.committed_at,
      payload_json: row.payload_json,
    };
  }

  /** 提交终态（幂等安全：只从 draft → committed 一次）。 */
  markCommitted(merchantId: string, draftId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE merchant_management_import_drafts
         SET status = 'committed', committed_at = ?
         WHERE draft_id = ? AND merchant_id = ? AND status = 'draft'`,
      )
      .run(this.now(), draftId, merchantId);
    return result.changes === 1;
  }
}
