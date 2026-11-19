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
 * 两方流程（48 小时审查 P0-1）：商家侧（memory:write）创建请求并取得
 * 一次性短语/卡片引用，经带外渠道送达已验证的客户联系方式；客户会话
 * （customer:self）回传短语或卡片引用完成确认。签发者不得自我确认，且
 * 确认方必须已绑定到请求主体——短语本身不能替代主体绑定。
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

  /** 当前 actor 的有效绑定主体；未绑定/已撤销/过期返回 undefined。 */
  private boundSubject(merchantId: string, actorId: string, stamp: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT subject_id FROM subject_bindings
          WHERE merchant_id = ? AND actor_id = ? AND status = 'ACTIVE' AND expires_at > ?
          ORDER BY binding_epoch DESC LIMIT 1`,
      )
      .get(merchantId, actorId, stamp) as { subject_id: string } | undefined;
    return row?.subject_id;
  }

  private assertScopeUsable(merchantId: string, scopeId: string): void {
    const row = this.db
      .prepare("SELECT state FROM data_scopes WHERE merchant_id = ? AND erase_scope_id = ?")
      .get(merchantId, scopeId) as { state: string } | undefined;
    // 未登记 scope 允许首次授权时建立（见下方 INSERT）；已封存/删除的 scope
    // 不能被新的 ACTIVE grant 复活。
    if (row !== undefined && row.state !== "ACTIVE") {
      throw new CustomerMemoryError("access_denied", "scope_sealed", "数据域已封存，不能新建授权");
    }
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
    // P0-1：只有商家侧（memory:write）能签发授权请求。客户会话拿到短语
    // 就等于拿到证明——证明必须由商家经带外渠道送达，不能由客户自签自发。
    requireActor(input.actor, merchantId, "memory:write");
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
           consumed_at, created_at, issuer_actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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
        input.actor.actor_id,
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
   * 错误引用一律拒绝，不创建 grant。确认方必须是已绑定到请求主体的客户
   * 会话，且不能是请求签发者本人。
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
          `SELECT grant_requests.grant_request_id, grant_requests.merchant_id,
                  grant_requests.subject_id, grant_requests.purpose,
                  grant_requests.resource_scope_id, grant_requests.grant_ttl_seconds,
                  grant_requests.expires_at, grant_requests.consumed_at,
                  grant_requests.created_at, grant_requests.phrase_digest,
                  grant_requests.confirmation_ref_digest, grant_requests.issuer_actor_id
             FROM grant_requests
            WHERE grant_requests.merchant_id = ? AND grant_requests.grant_request_id = ?`,
        )
        .get(merchantId, requestId) as
        | (GrantRequestRecord & {
            phrase_digest: string;
            confirmation_ref_digest: string;
            purpose: DataUsePurpose;
            issuer_actor_id: string | null;
          })
        | undefined;
      const phraseOk =
        input.confirmation_phrase !== undefined &&
        row?.phrase_digest === contentDigest({ purpose: "grant_phrase", phrase: input.confirmation_phrase });
      const refOk =
        input.confirmation_ref !== undefined &&
        row?.confirmation_ref_digest === contentDigest({ purpose: "grant_ref", ref: input.confirmation_ref });
      if (row === undefined || (!phraseOk && !refOk)) {
        throw new CustomerMemoryError("confirmation_invalid", "confirmation_mismatch", "确认短语或引用不匹配");
      }
      if (row.consumed_at !== null) {
        throw new CustomerMemoryError("confirmation_consumed", "grant_request_consumed", "授权请求已消费");
      }
      const stamp = nowUtc(this.now);
      if (row.expires_at <= stamp) {
        throw new CustomerMemoryError("confirmation_expired", "grant_request_expired", "授权请求已过期");
      }
      // P0-1：同一 actor 既是签发者又是确认者 → 证明不成立；旧版自签自发
      // 记录（issuer_actor_id 为 NULL）同样不可确认。
      if (row.issuer_actor_id === null || row.issuer_actor_id === input.actor.actor_id) {
        throw new CustomerMemoryError(
          "access_denied",
          "issuer_cannot_confirm",
          "授权请求必须由已绑定的客户会话确认，签发者不能自我确认",
        );
      }
      const boundSubject = this.boundSubject(merchantId, input.actor.actor_id, stamp);
      if (boundSubject !== row.subject_id) {
        throw new CustomerMemoryError(
          "access_denied",
          "subject_not_bound",
          "当前会话未绑定到该授权主体",
        );
      }
      const subjectRow = this.db
        .prepare("SELECT status FROM customer_subjects WHERE merchant_id = ? AND subject_id = ?")
        .get(merchantId, row.subject_id) as { status: string } | undefined;
      if (subjectRow === undefined || subjectRow.status !== "ACTIVE") {
        throw new CustomerMemoryError("not_found", "subject_not_found", "主体不存在或不可见");
      }
      this.assertScopeUsable(merchantId, row.resource_scope_id);
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
