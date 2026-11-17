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
 * 客户授权请求与一次性确认（设计 v1.1 §9.2 / D-M0-02 / M3-1）。
 *
 * 文本路径：服务端生成一次性确认短语，客户在同一会话原样回传。
 * 卡片路径：宿主卡片回调携带 grant_request_id + confirmation_ref。
 * 两条路径共用同一校验；自由文本不构成确认，消费后重放/跨会话均拒绝。
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { contentDigest } from "../../negotiation/jcs.js";
import type { ActorContext } from "../context-governance/actor-context.js";
import { hasCapability } from "../context-governance/actor-context.js";
import {
  DATA_USE_PURPOSES,
  GOVERNANCE_POLICY_VERSION,
  type DataUsePurpose,
} from "../context-governance/types.js";
import {
  DataUseGrantStore,
  type DataUseGrant,
} from "../context-governance/data-use-grant.js";
import { inImmediateTransaction } from "../storage/transaction.js";
import { CustomerMemoryError } from "./types.js";

const DEFAULT_REQUEST_TTL_SECONDS = 900;
const MAX_GRANT_TTL_SECONDS = 90 * 24 * 60 * 60;

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

function requireActor(actor: ActorContext, merchantId: string, capability: "memory:write" | "customer:self"): void {
  if (actor.merchant_id !== merchantId) {
    throw new CustomerMemoryError("access_denied", "actor_merchant_mismatch", "ActorContext 与商家作用域不一致");
  }
  if (actor.policy_version !== GOVERNANCE_POLICY_VERSION) {
    throw new CustomerMemoryError("validation", "policy_version_mismatch", "治理策略版本不一致");
  }
  if (!hasCapability(actor, capability)) {
    throw new CustomerMemoryError("access_denied", "capability_missing", `actor 缺少 ${capability}`);
  }
}

function nowUtc(now: () => string): string {
  const ms = Date.parse(now());
  if (!Number.isFinite(ms)) {
    throw new CustomerMemoryError("validation", "now_invalid", "时钟输出必须是可解析的 RFC3339 时间");
  }
  return new Date(ms).toISOString();
}

export interface GrantRequestRecord {
  readonly grant_request_id: string;
  readonly merchant_id: string;
  readonly subject_id: string;
  readonly purpose: DataUsePurpose;
  readonly resource_scope_id: string;
  readonly grant_ttl_seconds: number;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly created_at: string;
}

export class GrantRequestService {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly grants: DataUseGrantStore;

  constructor(options: { db: DatabaseSync; now: () => string }) {
    this.db = options.db;
    this.now = options.now;
    this.grants = new DataUseGrantStore({ db: options.db, now: options.now });
  }

  /**
   * 创建授权请求：返回一次性短语与卡片引用（各存摘要）。请求 TTL 默认 15
   * 分钟；授权 TTL 默认 90 天，受 90 天上限（试点值）。
   */
  createGrantRequest(input: {
    merchant_id: string;
    actor: ActorContext;
    subject_id: string;
    purpose: DataUsePurpose;
    resource_scope_id: string;
    request_ttl_seconds?: number;
    grant_ttl_seconds?: number;
  }): {
    grant_request: GrantRequestRecord;
    confirmation_phrase: string;
    confirmation_ref: string;
  } {
    const merchantId = text(input.merchant_id, "merchant_id");
    if (
      !hasCapability(input.actor, "memory:write") &&
      !hasCapability(input.actor, "customer:self")
    ) {
      throw new CustomerMemoryError(
        "access_denied",
        "capability_missing",
        "缺少 memory:write/customer:self",
      );
    }
    if (input.actor.merchant_id !== merchantId) {
      throw new CustomerMemoryError("access_denied", "actor_merchant_mismatch", "ActorContext 与商家作用域不一致");
    }
    if (!(DATA_USE_PURPOSES as readonly string[]).includes(input.purpose)) {
      throw new CustomerMemoryError("validation", "purpose_unknown", "未知数据用途");
    }
    const subjectId = text(input.subject_id, "subject_id");
    const subject = this.db
      .prepare("SELECT status FROM customer_subjects WHERE merchant_id = ? AND subject_id = ?")
      .get(merchantId, subjectId) as { status: string } | undefined;
    if (subject === undefined || subject.status !== "ACTIVE") {
      throw new CustomerMemoryError("not_found", "subject_not_found", "主体不存在或不可见");
    }
    const scopeId = text(input.resource_scope_id, "resource_scope_id");
    const requestTtl = input.request_ttl_seconds ?? DEFAULT_REQUEST_TTL_SECONDS;
    if (!Number.isSafeInteger(requestTtl) || requestTtl < 60 || requestTtl > 3600) {
      throw new CustomerMemoryError("validation", "request_ttl_invalid", "请求 TTL 必须为 60..3600 秒");
    }
    const grantTtl = input.grant_ttl_seconds ?? MAX_GRANT_TTL_SECONDS;
    if (!Number.isSafeInteger(grantTtl) || grantTtl < 60 || grantTtl > MAX_GRANT_TTL_SECONDS) {
      throw new CustomerMemoryError("validation", "grant_ttl_invalid", "授权 TTL 超出允许范围");
    }
    const stamp = nowUtc(this.now);
    const grantRequestId = `greq_${randomUUID()}`;
    const confirmationPhrase = `确认授权-${randomBytes(3).toString("hex").toUpperCase()}`;
    const confirmationRef = `gref_${randomBytes(18).toString("base64url")}`;
    const expiresAt = new Date(Date.parse(stamp) + requestTtl * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO grant_requests
          (grant_request_id, merchant_id, subject_id, purpose, resource_scope_id,
           grant_ttl_seconds, phrase_digest, confirmation_ref_digest, expires_at,
           consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        grantRequestId,
        merchantId,
        subjectId,
        input.purpose,
        scopeId,
        grantTtl,
        contentDigest({ purpose: "grant_phrase", phrase: confirmationPhrase }),
        contentDigest({ purpose: "grant_ref", ref: confirmationRef }),
        expiresAt,
        stamp,
      );
    return {
      grant_request: {
        grant_request_id: grantRequestId,
        merchant_id: merchantId,
        subject_id: subjectId,
        purpose: input.purpose,
        resource_scope_id: scopeId,
        grant_ttl_seconds: grantTtl,
        expires_at: expiresAt,
        consumed_at: null,
        created_at: stamp,
      },
      confirmation_phrase: confirmationPhrase,
      confirmation_ref: confirmationRef,
    };
  }

  /**
   * 一次性确认：phrase 或 confirmation_ref 任一匹配即可；消费后重放/过期/
   * 错误引用一律拒绝，不创建 grant。
   */
  confirmGrant(input: {
    merchant_id: string;
    actor: ActorContext;
    grant_request_id: string;
    confirmation_phrase?: string;
    confirmation_ref?: string;
  }): DataUseGrant {
    const merchantId = text(input.merchant_id, "merchant_id");
    requireActor(input.actor, merchantId, "customer:self");
    const requestId = text(input.grant_request_id, "grant_request_id");
    if (
      (input.confirmation_phrase === undefined) === (input.confirmation_ref === undefined)
    ) {
      throw new CustomerMemoryError("validation", "confirmation_required", "必须提供短语或卡片引用之一");
    }
    return inImmediateTransaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT * FROM grant_requests WHERE merchant_id = ? AND grant_request_id = ?",
        )
        .get(merchantId, requestId) as
        | (GrantRequestRecord & {
            phrase_digest: string;
            confirmation_ref_digest: string;
            purpose: DataUsePurpose;
          })
        | undefined;
      if (row === undefined) {
        throw new CustomerMemoryError("not_found", "grant_request_not_found", "授权请求不存在或不可见");
      }
      if (row.consumed_at !== null) {
        throw new CustomerMemoryError("confirmation_consumed", "grant_request_consumed", "授权请求已消费");
      }
      const stamp = nowUtc(this.now);
      if (row.expires_at <= stamp) {
        throw new CustomerMemoryError("confirmation_expired", "grant_request_expired", "授权请求已过期");
      }
      const phraseOk =
        input.confirmation_phrase !== undefined &&
        row.phrase_digest === contentDigest({ purpose: "grant_phrase", phrase: input.confirmation_phrase });
      const refOk =
        input.confirmation_ref !== undefined &&
        row.confirmation_ref_digest === contentDigest({ purpose: "grant_ref", ref: input.confirmation_ref });
      if (!phraseOk && !refOk) {
        throw new CustomerMemoryError("confirmation_invalid", "confirmation_mismatch", "确认短语或引用不匹配");
      }
      this.db
        .prepare(
          "UPDATE grant_requests SET consumed_at = ? WHERE merchant_id = ? AND grant_request_id = ?",
        )
        .run(stamp, merchantId, requestId);
      // 授权确认即建立资源域（未封存时）；已封存 scope 不被复活。
      this.db
        .prepare(
          `INSERT INTO data_scopes
            (merchant_id, erase_scope_id, data_epoch, state, sealed_at, updated_at)
           VALUES (?, ?, 1, 'ACTIVE', NULL, ?)
           ON CONFLICT(merchant_id, erase_scope_id) DO NOTHING`,
        )
        .run(merchantId, row.resource_scope_id, stamp);
      const expiresAt = new Date(
        Date.parse(stamp) + row.grant_ttl_seconds * 1000,
      ).toISOString();
      return this.grants.createGrant({
        merchant_id: merchantId,
        subject_id: row.subject_id,
        purpose: row.purpose,
        resource_scope_id: row.resource_scope_id,
        expires_at: expiresAt,
      });
    });
  }

  getGrantRequest(merchantId: string, requestId: string): GrantRequestRecord | undefined {
    return this.db
      .prepare("SELECT * FROM grant_requests WHERE merchant_id = ? AND grant_request_id = ?")
      .get(text(merchantId, "merchant_id"), text(requestId, "grant_request_id")) as unknown as
      | GrantRequestRecord
      | undefined;
  }
}
