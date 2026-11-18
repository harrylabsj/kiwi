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
 * 首询自动分配本店客户 ID（买家识别与交易回执 · K1，设计 §2.2）。
 *
 * 以「商家 ID + 验签所得 actor」为唯一查找键，在一个事务内创建或复用
 * `agent_scope` 主体；其 subject_id 即本店客户 ID。当前 subject_bindings 的
 * actor 索引不唯一且绑定可过期，因此不拿“当前有效绑定”兼任长期客户号——
 * 长期关系由 verified_customer_identities 映射承担（迁移 v4），绑定只是
 * 该映射当次会话的会话级证据：
 *
 * - 映射不存在：创建主体 + epoch 1 绑定 + 映射（同一事务）。
 * - 映射存在且最新绑定 ACTIVE 未过期：只复用，不新建（并发/重试零副作用）。
 * - 映射存在但绑定过期：同一事务内续绑（epoch = max+1）——客户号稳定，
 *   “绑定过期不新建客户号”（A6）。
 * - 映射存在且最新绑定 REVOKED：不自动重建绑定（再次建档不得恢复已撤销
 *   授权，设计 §2）；映射与客户号保留，跨次读取由授权检查另行拒绝。
 *
 * 全部写入走 `inImmediateTransaction`；唯一主键保证并发建档只产生一个主体。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { createActorContext } from "../context-governance/actor-context.js";
import { inImmediateTransaction } from "../storage/transaction.js";
import { CustomerIdentityService } from "./identity.js";
import { CustomerMemoryError } from "./types.js";

const IDENTITY_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 自动建档动作的稳定结果。 */
export interface VerifiedCustomerIdentity {
  readonly subject_id: string;
  /** 本次是否新建了本店客户主体（复用为 false）。 */
  readonly created: boolean;
  /** 当前生效（或本次续绑）的绑定 epoch；REVOKED 未续绑时为 undefined。 */
  readonly binding_epoch?: number;
  /** 本次是否新建了绑定（复用既有 ACTIVE 绑定 / 未续绑为 false）。 */
  readonly binding_created?: boolean;
}

function requireActorId(actor: string): string {
  if (typeof actor !== "string" || actor.length === 0 || actor.length > 256) {
    throw new CustomerMemoryError("validation", "verified_actor_invalid", "verified actor 必须是 1..256 字符");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(actor)) {
    throw new CustomerMemoryError("validation", "verified_actor_invalid", "verified actor 含控制字符");
  }
  return actor;
}

function requireMerchantId(merchantId: string): string {
  if (typeof merchantId !== "string" || merchantId.length === 0 || merchantId.length > 128) {
    throw new CustomerMemoryError("validation", "merchant_id_invalid", "merchant_id 必须是 1..128 字符");
  }
  return merchantId;
}

/**
 * 幂等自动建档：同一 (merchant_id, verified_actor) 恒返回同一 subject_id。
 * 调用方必须已确认 `identityVerified === true` 且属于受支持的开放询价身份；
 * 本函数不做验签——那是传输层（open-inquiry verifier）的职责。
 */
export function ensureVerifiedCustomerIdentity(
  db: DatabaseSync,
  input: { merchant_id: string; verified_actor: string; now: string },
): VerifiedCustomerIdentity {
  const merchantId = requireMerchantId(input.merchant_id);
  const actor = requireActorId(input.verified_actor);
  const stamp = normalizeNow(input.now);
  return inImmediateTransaction(db, () => {
    const existing = db
      .prepare(
        "SELECT subject_id, binding_epoch FROM verified_customer_identities WHERE merchant_id = ? AND verified_actor = ?",
      )
      .get(merchantId, actor) as { subject_id: string; binding_epoch: number } | undefined;

    if (existing !== undefined) {
      return rebindExisting(db, merchantId, actor, existing.subject_id, stamp);
    }

    // 新建档：主体 + epoch 1 绑定 + 映射，一个事务。
    const identity = new CustomerIdentityService({ db, now: () => stamp });
    const systemActor = createActorContext({
      merchant_id: merchantId,
      actor_id: "system:open-inquiry-identity",
      auth_strength: "verified",
      subject_binding: "organization",
      capabilities: ["memory:write"],
    });
    const subject = identity.createSubject({
      merchant_id: merchantId,
      actor: systemActor,
      subject_kind: "agent_scope",
    });
    const bindingEpoch = 1;
    db.prepare(
      `INSERT INTO subject_bindings
        (binding_id, merchant_id, subject_id, actor_id, issuer, assurance_class,
         proof_ref, binding_epoch, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open-inquiry', 'verified-key', ?, ?, 'ACTIVE', ?, ?, ?)`,
    ).run(
      `bind_${randomUUID()}`,
      merchantId,
      subject.subject_id,
      actor,
      `sha256:${actor}`,
      bindingEpoch,
      new Date(Date.parse(stamp) + IDENTITY_BINDING_TTL_MS).toISOString(),
      stamp,
      stamp,
    );
    db.prepare(
      `INSERT INTO verified_customer_identities
        (merchant_id, verified_actor, subject_id, binding_epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(merchantId, actor, subject.subject_id, bindingEpoch, stamp, stamp);
    return {
      subject_id: subject.subject_id,
      created: true,
      binding_epoch: bindingEpoch,
      binding_created: true,
    };
  });
}

/**
 * 已有映射时的复用/续绑判定。REVOKED 绑定不自动重建；过期绑定在同一事务内
 * 续绑（epoch 递增，旧主体绑定不复用）。
 */
function rebindExisting(
  db: DatabaseSync,
  merchantId: string,
  actor: string,
  subjectId: string,
  stamp: string,
): VerifiedCustomerIdentity {
  const latest = db
    .prepare(
      `SELECT binding_epoch, status, expires_at FROM subject_bindings
        WHERE merchant_id = ? AND actor_id = ? AND subject_id = ?
        ORDER BY binding_epoch DESC LIMIT 1`,
    )
    .get(merchantId, actor, subjectId) as
    | { binding_epoch: number; status: string; expires_at: string }
    | undefined;

  if (latest === undefined) {
    // 映射存在但没有任何绑定行（历史数据/手工清理）：补一条会话绑定。
    return insertRebinding(db, merchantId, actor, subjectId, latestEpoch(db, merchantId, actor, subjectId), stamp);
  }
  if (latest.status === "REVOKED") {
    return { subject_id: subjectId, created: false, binding_created: false };
  }
  if (latest.expires_at > stamp) {
    return {
      subject_id: subjectId,
      created: false,
      binding_epoch: latest.binding_epoch,
      binding_created: false,
    };
  }
  return insertRebinding(db, merchantId, actor, subjectId, latest.binding_epoch, stamp);
}

function latestEpoch(db: DatabaseSync, merchantId: string, actor: string, subjectId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(binding_epoch), 0) AS epoch FROM subject_bindings
        WHERE merchant_id = ? AND actor_id = ? AND subject_id = ?`,
    )
    .get(merchantId, actor, subjectId) as { epoch: number };
  return Number(row.epoch);
}

function insertRebinding(
  db: DatabaseSync,
  merchantId: string,
  actor: string,
  subjectId: string,
  previousEpoch: number,
  stamp: string,
): VerifiedCustomerIdentity {
  const bindingEpoch = previousEpoch + 1;
  db.prepare(
    `INSERT INTO subject_bindings
      (binding_id, merchant_id, subject_id, actor_id, issuer, assurance_class,
       proof_ref, binding_epoch, status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open-inquiry', 'verified-key', ?, ?, 'ACTIVE', ?, ?, ?)`,
  ).run(
    `bind_${randomUUID()}`,
    merchantId,
    subjectId,
    actor,
    `sha256:${actor}`,
    bindingEpoch,
    new Date(Date.parse(stamp) + IDENTITY_BINDING_TTL_MS).toISOString(),
    stamp,
    stamp,
  );
  db.prepare(
    `UPDATE verified_customer_identities SET binding_epoch = ?, updated_at = ?
      WHERE merchant_id = ? AND verified_actor = ?`,
  ).run(bindingEpoch, stamp, merchantId, actor);
  return { subject_id: subjectId, created: false, binding_epoch: bindingEpoch, binding_created: true };
}

function normalizeNow(now: string): string {
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed)) {
    throw new CustomerMemoryError("validation", "now_invalid", "时钟输出必须是可解析的 RFC3339 时间");
  }
  return new Date(parsed).toISOString();
}

/**
 * 只读查询：本店客户号（不产生任何写入）。接待/历史读取走此入口，
 * 与 `currentSubjectForActor` 的会话级绑定查询分开。
 */
export function findVerifiedCustomerIdentity(
  db: DatabaseSync,
  merchantId: string,
  verifiedActor: string,
): { subject_id: string } | undefined {
  const row = db
    .prepare(
      "SELECT subject_id FROM verified_customer_identities WHERE merchant_id = ? AND verified_actor = ?",
    )
    .get(requireMerchantId(merchantId), requireActorId(verifiedActor)) as
    | { subject_id: string }
    | undefined;
  return row;
}
