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
 * 客户主体与绑定（设计 v1.1 §9.1 / §9.2 / D-M0-01 / M3-0）。
 *
 * - P0 只创建 organization / agent_scope 主体；person / verified_person 拒绝。
 * - 绑定挑战由商家侧（memory:write）签发，5 分钟有效、单次消费；挑战证明
 *   经带外渠道送达客户，由客户会话（customer:self）确认后创建新 binding_epoch。
 *   签发者不能自我确认——同一会话既是挑战签发者又是证明消费者不构成身份证明。
 * - 撤销绑定递增 epoch；旧主体绑定不复用。昵称/电话/IP/文本相似度不能建立身份。
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { contentDigest } from "../../negotiation/jcs.js";
import type { ActorContext } from "../context-governance/actor-context.js";
import { hasCapability } from "../context-governance/actor-context.js";
import { GOVERNANCE_POLICY_VERSION } from "../context-governance/types.js";
import { inImmediateTransaction } from "../storage/transaction.js";
import {
  CustomerMemoryError,
  P0_SUBJECT_KINDS,
  type CustomerSubject,
  type CustomerSubjectKind,
  type SubjectBinding,
} from "./types.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function id(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new CustomerMemoryError("validation", `${field}_invalid`, `${field} 必须是 1..128 字符`);
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

export class CustomerIdentityService {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now: () => string }) {
    this.db = options.db;
    this.now = options.now;
  }

  createSubject(input: {
    merchant_id: string;
    actor: ActorContext;
    subject_kind: CustomerSubjectKind;
  }): CustomerSubject {
    const merchantId = id(input.merchant_id, "merchant_id");
    requireActor(input.actor, merchantId, "memory:write");
    if (!P0_SUBJECT_KINDS.has(input.subject_kind)) {
      throw new CustomerMemoryError(
        "validation",
        "subject_kind_rejected",
        `P0 只启用 organization / agent_scope（D-M0-01）：${input.subject_kind}`,
      );
    }
    const stamp = nowUtc(this.now);
    const subject: CustomerSubject = {
      subject_id: `subj_${randomUUID()}`,
      merchant_id: merchantId,
      subject_kind: input.subject_kind,
      status: "ACTIVE",
      created_at: stamp,
      updated_at: stamp,
    };
    this.db
      .prepare(
        `INSERT INTO customer_subjects
          (subject_id, merchant_id, subject_kind, status, created_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
      )
      .run(subject.subject_id, merchantId, subject.subject_kind, stamp, stamp);
    return subject;
  }

  getSubject(merchantId: string, subjectId: string): CustomerSubject | undefined {
    const row = this.db
      .prepare("SELECT * FROM customer_subjects WHERE merchant_id = ? AND subject_id = ?")
      .get(id(merchantId, "merchant_id"), id(subjectId, "subject_id")) as unknown as
      | CustomerSubject
      | undefined;
    return row;
  }

  linkChallenge(input: {
    merchant_id: string;
    actor: ActorContext;
    source_session_id: string;
    target_subject_id: string;
    scope?: readonly string[];
    ttl_seconds?: number;
  }): { challenge_id: string; proof: string; expires_at: string } {
    const merchantId = id(input.merchant_id, "merchant_id");
    // P0-2：挑战只能由商家侧签发；证明由商家带外送达客户，客户会话不能
    // 为任意主体自行签发挑战。
    requireActor(input.actor, merchantId, "memory:write");
    const sessionId = id(input.source_session_id, "source_session_id");
    const subjectId = id(input.target_subject_id, "target_subject_id");
    const subject = this.getSubject(merchantId, subjectId);
    if (subject === undefined || subject.status !== "ACTIVE") {
      throw new CustomerMemoryError("not_found", "subject_not_found", "主体不存在或不可见");
    }
    const scope = (input.scope ?? []).map((item) => id(item, "scope"));
    if (scope.length > 20) {
      throw new CustomerMemoryError("validation", "scope_too_many", "scope 最多 20 项");
    }
    const ttlSeconds = input.ttl_seconds ?? 300;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 300) {
      throw new CustomerMemoryError("validation", "ttl_invalid", "挑战 ttl 必须为 60..300 秒");
    }
    const stamp = nowUtc(this.now);
    const challengeId = `chl_${randomUUID()}`;
    const proof = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.parse(stamp) + Math.min(ttlSeconds * 1000, CHALLENGE_TTL_MS)).toISOString();
    this.db
      .prepare(
        `INSERT INTO binding_challenges
          (challenge_id, merchant_id, actor_id, source_session_id, target_subject_id,
           scope_json, proof_digest, expires_at, consumed_at, created_at, issuer_actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        challengeId,
        merchantId,
        input.actor.actor_id,
        sessionId,
        subjectId,
        JSON.stringify(scope),
        contentDigest({ purpose: "binding_challenge", proof }),
        expiresAt,
        stamp,
        input.actor.actor_id,
      );
    return { challenge_id: challengeId, proof, expires_at: expiresAt };
  }

  linkConfirm(input: {
    merchant_id: string;
    actor: ActorContext;
    challenge_id: string;
    source_session_id: string;
    proof: string;
    expires_at?: string;
  }): SubjectBinding {
    const merchantId = id(input.merchant_id, "merchant_id");
    requireActor(input.actor, merchantId, "customer:self");
    const challengeId = id(input.challenge_id, "challenge_id");
    const sessionId = id(input.source_session_id, "source_session_id");
    return inImmediateTransaction(this.db, () => {
      const row = this.db
        .prepare("SELECT * FROM binding_challenges WHERE merchant_id = ? AND challenge_id = ?")
        .get(merchantId, challengeId) as unknown as
        | {
            actor_id: string;
            issuer_actor_id: string | null;
            source_session_id: string;
            target_subject_id: string;
            proof_digest: string;
            expires_at: string;
            consumed_at: string | null;
          }
        | undefined;
      if (row === undefined) {
        throw new CustomerMemoryError("not_found", "challenge_not_found", "绑定挑战不存在或不可见");
      }
      if (row.consumed_at !== null) {
        throw new CustomerMemoryError("confirmation_consumed", "challenge_consumed", "挑战已消费");
      }
      const stamp = nowUtc(this.now);
      if (row.expires_at <= stamp) {
        throw new CustomerMemoryError("confirmation_expired", "challenge_expired", "挑战已过期");
      }
      // P0-2：签发者不能自我确认；旧版自签挑战（无签发者）一律拒绝。
      if (row.issuer_actor_id === null || row.issuer_actor_id === input.actor.actor_id) {
        throw new CustomerMemoryError(
          "access_denied",
          "issuer_cannot_confirm",
          "绑定挑战必须由客户会话确认，签发者不能自我确认",
        );
      }
      const subject = this.getSubject(merchantId, row.target_subject_id);
      if (subject === undefined || subject.status !== "ACTIVE") {
        throw new CustomerMemoryError("not_found", "subject_not_found", "主体不存在或不可见");
      }
      if (row.proof_digest !== contentDigest({ purpose: "binding_challenge", proof: input.proof })) {
        throw new CustomerMemoryError("confirmation_invalid", "proof_mismatch", "绑定证明不匹配");
      }
      this.db
        .prepare(
          "UPDATE binding_challenges SET consumed_at = ? WHERE merchant_id = ? AND challenge_id = ?",
        )
        .run(stamp, merchantId, challengeId);
      const epochRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(binding_epoch), 0) AS epoch FROM subject_bindings
            WHERE merchant_id = ? AND actor_id = ? AND subject_id = ?`,
        )
        .get(merchantId, input.actor.actor_id, row.target_subject_id) as { epoch: number };
      const binding: SubjectBinding = {
        binding_id: `bind_${randomUUID()}`,
        merchant_id: merchantId,
        subject_id: row.target_subject_id,
        actor_id: input.actor.actor_id,
        issuer: "operator-out-of-band",
        assurance_class: "operator_verified",
        binding_epoch: Number(epochRow.epoch) + 1,
        status: "ACTIVE",
        expires_at: input.expires_at ?? new Date(Date.parse(stamp) + BINDING_TTL_MS).toISOString(),
        created_at: stamp,
        updated_at: stamp,
      };
      this.db
        .prepare(
          `INSERT INTO subject_bindings
            (binding_id, merchant_id, subject_id, actor_id, issuer, assurance_class,
             proof_ref, binding_epoch, status, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
        )
        .run(
          binding.binding_id,
          binding.merchant_id,
          binding.subject_id,
          binding.actor_id,
          binding.issuer,
          binding.assurance_class,
          contentDigest({ purpose: "binding_proof", challenge_id: challengeId, session_id: sessionId }),
          binding.binding_epoch,
          binding.expires_at,
          binding.created_at,
          binding.updated_at,
        );
      return binding;
    });
  }

  revokeBinding(input: {
    merchant_id: string;
    actor: ActorContext;
    binding_id: string;
    expected_epoch: number;
  }): SubjectBinding {
    const merchantId = id(input.merchant_id, "merchant_id");
    if (
      !hasCapability(input.actor, "customer:self") &&
      !hasCapability(input.actor, "memory:write")
    ) {
      throw new CustomerMemoryError("access_denied", "capability_missing", "缺少 customer:self/memory:write");
    }
    if (input.actor.merchant_id !== merchantId) {
      throw new CustomerMemoryError("access_denied", "actor_merchant_mismatch", "ActorContext 与商家作用域不一致");
    }
    const bindingId = id(input.binding_id, "binding_id");
    return inImmediateTransaction(this.db, () => {
      const stamp = nowUtc(this.now);
      const result = this.db
        .prepare(
          `UPDATE subject_bindings SET status = 'REVOKED', updated_at = ?
            WHERE merchant_id = ? AND binding_id = ? AND binding_epoch = ? AND status = 'ACTIVE'`,
        )
        .run(stamp, merchantId, bindingId, input.expected_epoch);
      if (Number(result.changes) !== 1) {
        throw new CustomerMemoryError(
          "version_conflict",
          "binding_epoch_mismatch",
          "绑定已变化或不属于该主体",
        );
      }
      return this.db
        .prepare("SELECT * FROM subject_bindings WHERE merchant_id = ? AND binding_id = ?")
        .get(merchantId, bindingId) as unknown as SubjectBinding;
    });
  }

  /** 当前会话 actor 的有效绑定（最新 epoch）；undefined = 未绑定/已撤销/过期。 */
  currentSubjectForActor(
    merchantId: string,
    actorId: string,
  ): { subject_id: string; binding_id: string; binding_epoch: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT subject_id, binding_id, binding_epoch FROM subject_bindings
          WHERE merchant_id = ? AND actor_id = ? AND status = 'ACTIVE' AND expires_at > ?
          ORDER BY binding_epoch DESC LIMIT 1`,
      )
      .get(id(merchantId, "merchant_id"), id(actorId, "actor_id"), nowUtc(this.now)) as
      | { subject_id: string; binding_id: string; binding_epoch: number }
      | undefined;
    return row;
  }

  currentBindingEpoch(merchantId: string, actorId: string): number | undefined {
    return this.currentSubjectForActor(merchantId, actorId)?.binding_epoch;
  }

  listBindings(merchantId: string, subjectId?: string): SubjectBinding[] {
    return (
      subjectId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM subject_bindings WHERE merchant_id = ? ORDER BY binding_epoch ASC",
            )
            .all(id(merchantId, "merchant_id"))
        : this.db
            .prepare(
              "SELECT * FROM subject_bindings WHERE merchant_id = ? AND subject_id = ? ORDER BY binding_epoch ASC",
            )
            .all(id(merchantId, "merchant_id"), id(subjectId, "subject_id"))
    ) as unknown as SubjectBinding[];
  }
}
