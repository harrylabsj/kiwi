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
 * 开通记录存储（设计 §7.1 / §7.2；M4）。**服务端权威，不是会话记忆**。
 *
 * 四条不变量（都由测试钉住）：
 *
 * 1. **唯一开通记录**：`(merchant_id, production, primary)` 最多一条活跃记录；
 *    重复点击返回**同一条**，不新建（T008）。换版本/重建环境必须显式 `newGeneration`。
 * 2. **证据分级**：只有 `platform_query` 权威证据能推进关键状态、才能写入
 *    `applicationId`。文本 applicationId / LLM 的"已完成" / 适配器返回值只进
 *    `onboarding_evidence` 留痕，**永不改状态**（T029）。
 * 3. **CAS**：每次写带 `expectedRevision`，不匹配即 `stale_revision`——并发写不会
 *    互相覆盖（§7.2）。
 * 4. **幂等键三绑定**：Idempotency-Key + 请求摘要 + 商家身份。同 key 同摘要返回
 *    原结果；同 key 不同摘要 `conflict`（§7.2、T008）。
 */

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  isAuthoritative,
  ONBOARDING_TRANSITIONS,
  OnboardingError,
  type AuthoritativeEvidence,
  type Evidence,
  type OnboardingRecord,
  type OnboardingStatus,
} from "./types.js";

const SCHEMA = `
create table if not exists onboarding_records (
  record_id text primary key,
  intent_id text not null,
  merchant_id text not null,
  environment text not null,
  agent_slot text not null,
  generation integer not null,
  catalog_agent_id text not null,
  card_url text not null,
  version_digest text not null,
  application_id text,
  runtime_origin_host text,
  status text not null,
  revision integer not null,
  last_successful_step text,
  last_error text,
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_onboarding_merchant
  on onboarding_records(merchant_id, environment, agent_slot);
create table if not exists onboarding_slots (
  merchant_id text not null,
  environment text not null,
  agent_slot text not null,
  current_record_id text not null,
  generation integer not null,
  updated_at text not null,
  primary key (merchant_id, environment, agent_slot)
);
create table if not exists onboarding_idempotency (
  idempotency_key text primary key,
  merchant_id text not null,
  request_digest text not null,
  record_id text not null,
  created_at text not null
);
create table if not exists onboarding_evidence (
  evidence_id text primary key,
  record_id text not null,
  kind text not null,
  authoritative integer not null,
  summary text not null,
  observed_at text not null,
  created_at text not null
);
`;

/** 终态：不再占用"活跃记录"名额。 */
const TERMINAL_STATUSES: ReadonlySet<OnboardingStatus> = new Set(["CANCELLED"]);

/**
 * 需要**权威证据**才能进入的状态（§7.2「平台实际查询回执才可推进关键状态」）。
 *
 * `DRAFT` / `AWAITING_PLATFORM_CONSENT` 是流程内的确定性推进（还没碰到平台），
 * 失败态可由调用方按错误性质驱动；其余全部要求权威回执。
 */
const AUTHORITATIVE_REQUIRED: ReadonlySet<OnboardingStatus> = new Set([
  "ACTIVATED",
  // 注意 DEPLOYING **不在**此列：它是"我们开始发布制品"的本地动作；真正需要平台
  // 回执的是"公网应用确实出现了"（DEPLOYED_UNBOUND）——§7.1 的进入条件正是如此。

  "DEPLOYED_UNBOUND",
  "BOUND",
  "VERIFYING",
  "READY_TO_PUBLISH",
  "PUBLISHED",
]);

export interface OpenIntentInput {
  merchantId: string;
  intentId: string;
  versionDigest: string;
  /** 调用方给的幂等键（同一次"点击"重试必须复用同一个）。 */
  idempotencyKey: string;
  /** 请求摘要（正文的稳定哈希；由调用方或 `digestOf` 计算）。 */
  requestDigest: string;
  /** 预留的目录身份；缺省由 intentId 派生（确定性，便于重试复用同一身份）。 */
  catalogAgentId?: string;
  /** 显式新建部署代次（换版本/重建环境）。 */
  newGeneration?: boolean;
}

export interface AdvanceInput {
  recordId: string;
  expectedRevision: number;
  nextStatus: OnboardingStatus;
  /** 本次推进的步骤名（成功即记为 lastSuccessfulStep）。 */
  step?: string;
  /** 支撑本次推进的证据；进入关键状态时必须是权威证据。 */
  evidence?: Evidence;
  /** 平台报告的 runtime origin hostname（确定后写入）。 */
  runtimeOriginHost?: string;
  now?: string;
}

export interface ResumeContext {
  record: OnboardingRecord;
  /** 断点：从这一步之后继续（§7.2「从最后成功步骤续办」）。 */
  resumeFromStep: string | null;
  /** 恒为 true：恢复时必须**先查平台**，不能凭记录里的旧值直接继续。 */
  requiresPlatformQuery: true;
}

/** 稳定序列化摘要（幂等键的请求摘要口径）。 */
export function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

export class OnboardingStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(db: DatabaseSync, options: { now?: () => string } = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date().toISOString());
    // 多进程/多连接同时打开开通意图时，允许竞争者等待当前短事务完成，而不是在
    // 第一次锁竞争时直接 SQLITE_BUSY。真正的唯一性由 onboarding_slots 的复合主键
    // 与 openIntent() 的 BEGIN IMMEDIATE 共同保证，不依赖单进程 mutex。
    this.db.exec("pragma busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.backfillSlots();
  }

  /**
   * 打开（或复用）开通意图。
   *
   * 重复点击 / 响应丢失后重试（T009）都走这里：**先查**幂等键与活跃记录，命中就返回
   * 原记录，绝不新建、绝不换 applicationId。
   */
  openIntent(input: OpenIntentInput): OnboardingRecord {
    const merchantId = requireNonEmpty(input.merchantId, "merchantId");
    const intentId = requireNonEmpty(input.intentId, "intentId");
    const versionDigest = requireNonEmpty(input.versionDigest, "versionDigest");
    const idempotencyKey = requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    const requestDigest = requireNonEmpty(input.requestDigest, "requestDigest");

    // 读幂等键 → 读当前槽 → 插记录 → 切换槽 → 记幂等回执必须是一个存储原子
    // 边界。否则两个 Runtime/worker 可同时观察到“无活跃记录”并各自插入一条。
    // BEGIN IMMEDIATE 在读取前取得写保留锁；第二个连接会等待，随后读到同一槽位。
    this.db.exec("begin immediate");
    try {
      const seen = this.db
        .prepare("select merchant_id, request_digest, record_id from onboarding_idempotency where idempotency_key = ?")
        .get(idempotencyKey) as
        | { merchant_id: string; request_digest: string; record_id: string }
        | undefined;
      if (seen !== undefined) {
        // 同 key 不同摘要 = 复用了幂等键做另一件事 → 冲突（§7.2）。
        if (seen.request_digest !== requestDigest || seen.merchant_id !== merchantId) {
          throw new OnboardingError(
            "conflict",
            `idempotency key ${idempotencyKey} was used with a different request digest or merchant`,
          );
        }
        const replay = this.requireRecord(seen.record_id);
        this.db.exec("commit");
        return replay;
      }

      const active = this.activeRecord(merchantId);
      if (active !== undefined && input.newGeneration !== true) {
        // §7.1：一个商家重复点击只返回当前槽指向的同一记录。
        this.rememberIdempotency(idempotencyKey, merchantId, requestDigest, active.recordId);
        this.db.exec("commit");
        return active;
      }

      const generation = input.newGeneration === true ? this.nextGeneration(merchantId) : 1;
      const recordId = `onb_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const catalogAgentId = input.catalogAgentId ?? `cagt_${intentId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40)}`;
      const stamp = this.now();
      this.db
        .prepare(
          "insert into onboarding_records (record_id, intent_id, merchant_id, environment, agent_slot,"
            + " generation, catalog_agent_id, card_url, version_digest, application_id, runtime_origin_host,"
            + " status, revision, last_successful_step, last_error, created_at, updated_at)"
            + " values (?, ?, ?, 'production', 'primary', ?, ?, ?, ?, null, null, 'DRAFT', 0, null, null, ?, ?)",
        )
        .run(
          recordId,
          intentId,
          merchantId,
          generation,
          catalogAgentId,
          // 稳定名片地址在**创建意图时**就预留（§7.1：不等待"注册后才知道 Card 地址"）
          `/v1/agents/${catalogAgentId}/agent-card.json`,
          versionDigest,
          stamp,
          stamp,
        );
      this.db
        .prepare(
          "insert into onboarding_slots"
            + " (merchant_id, environment, agent_slot, current_record_id, generation, updated_at)"
            + " values (?, 'production', 'primary', ?, ?, ?)"
            + " on conflict(merchant_id, environment, agent_slot) do update set"
            + " current_record_id = excluded.current_record_id, generation = excluded.generation,"
            + " updated_at = excluded.updated_at",
        )
        .run(merchantId, recordId, generation, stamp);
      this.rememberIdempotency(idempotencyKey, merchantId, requestDigest, recordId);
      const created = this.requireRecord(recordId);
      this.db.exec("commit");
      return created;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  /** 商家当前活跃记录（无则 undefined）。 */
  activeRecord(merchantId: string): OnboardingRecord | undefined {
    const row = this.db
      .prepare(
        "select r.* from onboarding_slots s join onboarding_records r"
          + " on r.record_id = s.current_record_id"
          + " where s.merchant_id = ? and s.environment = 'production' and s.agent_slot = 'primary'",
      )
      .get(requireNonEmpty(merchantId, "merchantId")) as Record<string, unknown> | undefined;
    if (row === undefined || TERMINAL_STATUSES.has(row["status"] as OnboardingStatus)) return undefined;
    return toRecord(row);
  }

  getRecord(recordId: string): OnboardingRecord | undefined {
    const row = this.db
      .prepare("select * from onboarding_records where record_id = ?")
      .get(recordId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * 断点续办上下文（T010：中途退出后重开向导）。
   *
   * 返回值不是"可以继续了"，而是"**先查平台**再继续"——记录里的状态是**上次**的
   * 观测，平台侧可能已经变了（§7.2）。
   */
  resumeContext(merchantId: string): ResumeContext | undefined {
    const record = this.activeRecord(merchantId);
    if (record === undefined) return undefined;
    return { record, resumeFromStep: record.lastSuccessfulStep, requiresPlatformQuery: true };
  }

  /**
   * 推进状态（CAS + 迁移合法性 + 证据分级）。
   *
   * 进入关键状态而没有权威证据 → `evidence_not_authoritative`（T029：文本 applicationId
   * 与 LLM 的"已完成"永远到不了这里）。
   */
  advance(input: AdvanceInput): OnboardingRecord {
    const record = this.requireRecord(input.recordId);
    assertRevision(record, input.expectedRevision);
    assertTransition(record.status, input.nextStatus);

    const evidence = input.evidence;
    const authoritative = evidence !== undefined && isAuthoritative(evidence);

    // 两条**拒绝路径**不进下面的事务：「先留痕，再判定」（原顺序保持）——被拒的
    // "文本 applicationId / LLM 说完成了"同样要进审计，否则"有人说它开通了"这件事
    // 在系统里完全不可见——那正是要防的东西。证据必须持久化，不能随回滚消失（T029）。
    //
    // applicationId 的**唯一**写入点：权威回执。且只要拿到权威回执就**必须**与已
    // 持久化的那个一致——不一致就阻断（T011），与"这次想到哪个状态"无关。
    if (
      authoritative &&
      record.applicationId !== null &&
      record.applicationId !== evidence.applicationId
    ) {
      this.recordEvidence(record.recordId, evidence);
      this.markBlocked(
        record,
        `platform reported a different applicationId (${evidence.applicationId})`,
      );
      throw new OnboardingError(
        "application_id_mismatch",
        `platform reported applicationId ${evidence.applicationId}, record holds ${record.applicationId}`,
      );
    }

    // 进入关键状态而没有权威证据 → 拒（T029：文本 applicationId 与 LLM 的"已完成"
    // 永远到不了这里）。
    if (AUTHORITATIVE_REQUIRED.has(input.nextStatus) && !authoritative) {
      if (evidence !== undefined) {
        this.recordEvidence(record.recordId, evidence);
      }
      throw new OnboardingError(
        "evidence_not_authoritative",
        `transition ${record.status} → ${input.nextStatus} requires authoritative platform evidence`
          + " (adapter return values, pasted ids and LLM claims are pending evidence only)",
      );
    }

    const applicationId =
      evidence !== undefined && authoritative ? evidence.applicationId : record.applicationId;
    const stamp = this.now();
    const revision = record.revision + 1;
    // 成功路径的 recordEvidence + UPDATE 必须是一个存储原子边界（P2-1 刀 1 补漏）：
    // autocommit 下崩在两句之间会留下"有证据但状态没推进"的半截写。
    this.db.exec("begin immediate");
    try {
      if (evidence !== undefined) {
        this.recordEvidence(record.recordId, evidence);
      }
      this.db
        .prepare(
          "update onboarding_records set status = ?, revision = ?, application_id = ?,"
            + " runtime_origin_host = coalesce(?, runtime_origin_host),"
            + " last_successful_step = coalesce(?, last_successful_step), last_error = null, updated_at = ?"
            + " where record_id = ? and revision = ?",
        )
        .run(
          input.nextStatus,
          revision,
          applicationId,
          input.runtimeOriginHost ?? null,
          input.step ?? null,
          stamp,
          record.recordId,
          input.expectedRevision,
        );
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return this.requireRecord(record.recordId);
  }

  /**
   * 记录一条**待核查**证据：留痕，但**不改状态**。
   *
   * 这是"用户粘贴了 applicationId""LLM 说已部署"这类输入的唯一出口。
   */
  recordPendingEvidence(recordId: string, evidence: Evidence & { summary?: string }): void {
    this.requireRecord(recordId);
    this.recordEvidence(recordId, evidence);
  }

  /** 记录失败：`retryable` 决定进 FAILED_RETRYABLE 还是 BLOCKED。 */
  fail(
    recordId: string,
    expectedRevision: number,
    input: { reason: string; retryable: boolean; now?: string },
  ): OnboardingRecord {
    // 读判 + UPDATE 包进事务（P2-1 刀 1 补漏）：与 advance/cancel 同一存储原子
    // 边界口径——防并发写者插在"读到的 revision"与"条件 UPDATE"之间，也防后续
    // 给本方法加第二条写语句时退化成 autocommit 半截写。
    this.db.exec("begin immediate");
    try {
      const record = this.requireRecord(recordId);
      assertRevision(record, expectedRevision);
      const next: OnboardingStatus = input.retryable ? "FAILED_RETRYABLE" : "BLOCKED";
      assertTransition(record.status, next);
      this.db
        .prepare(
          "update onboarding_records set status = ?, revision = ?, last_error = ?, updated_at = ?"
            + " where record_id = ? and revision = ?",
        )
        .run(next, record.revision + 1, sanitizeError(input.reason), this.now(), recordId, expectedRevision);
      this.db.exec("commit");
      return this.requireRecord(recordId);
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  /**
   * 商家在平台确认框**拒绝**授权（T007）。
   *
   * 语义上这不是"失败"，而是"还在等"：**状态不变**（仍 AWAITING_PLATFORM_CONSENT），
   * applicationId 仍为 null，也绝不显示已开通。代确认、把拒绝当同意、或把状态推进
   * 到下一格都属于伪造商家意图——所以这里只记录，不改状态。
   *
   * 商家随后仍可重试（重新授权）或 `cancel()`（撤销意图）。
   */
  recordConsentRefused(
    recordId: string,
    expectedRevision: number,
    input: { note?: string } = {},
  ): OnboardingRecord {
    const record = this.requireRecord(recordId);
    assertRevision(record, expectedRevision);
    if (record.status !== "AWAITING_PLATFORM_CONSENT") {
      throw new OnboardingError(
        "illegal_transition",
        `consent refusal only applies while awaiting platform consent (status ${record.status})`,
      );
    }
    // recordEvidence + UPDATE 必须是一个存储原子边界（P2-1 刀 1 补漏）：autocommit
    // 下崩在两句之间会留下"有拒绝留痕但 revision 没推进"的半截写。
    this.db.exec("begin immediate");
    try {
      this.recordEvidence(recordId, {
        kind: "user_consent_receipt",
        summary: `consent refused: ${input.note ?? "merchant declined in the platform dialog"}`,
        observedAt: this.now(),
      });
      this.db
        .prepare(
          "update onboarding_records set revision = ?, last_error = ?, updated_at = ?"
            + " where record_id = ? and revision = ?",
        )
        .run(
          record.revision + 1,
          sanitizeError(input.note ?? "merchant declined platform consent; still waiting"),
          this.now(),
          recordId,
          expectedRevision,
        );
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return this.requireRecord(recordId);
  }

  /** 商家撤销开通意图。**不自动删已有云资源**（§7.1）。 */
  cancel(recordId: string, expectedRevision: number): OnboardingRecord {
    this.db.exec("begin immediate");
    try {
      const record = this.requireRecord(recordId);
      assertRevision(record, expectedRevision);
      assertTransition(record.status, "CANCELLED");
      const stamp = this.now();
      const changed = this.db
        .prepare("update onboarding_records set status = 'CANCELLED', revision = ?, updated_at = ? where record_id = ? and revision = ?")
        .run(record.revision + 1, stamp, recordId, expectedRevision);
      if (changed.changes !== 1) {
        throw new OnboardingError("stale_revision", `record ${recordId} changed while cancelling`);
      }
      this.db
        .prepare(
          "delete from onboarding_slots where merchant_id = ? and environment = ?"
            + " and agent_slot = ? and current_record_id = ?",
        )
        .run(record.merchantId, record.environment, record.agentSlot, recordId);
      const cancelled = this.requireRecord(recordId);
      this.db.exec("commit");
      return cancelled;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  /** 该记录的全部证据（审计/回溯用）。 */
  evidenceFor(recordId: string): Array<{ kind: string; authoritative: boolean; summary: string; observedAt: string }> {
    const rows = this.db
      .prepare("select kind, authoritative, summary, observed_at from onboarding_evidence where record_id = ? order by created_at")
      .all(recordId) as Record<string, unknown>[];
    return rows.map((row) => ({
      kind: String(row["kind"]),
      authoritative: Number(row["authoritative"]) === 1,
      summary: String(row["summary"]),
      observedAt: String(row["observed_at"]),
    }));
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private markBlocked(record: OnboardingRecord, reason: string): void {
    if (record.status === "BLOCKED" || record.status === "CANCELLED") return;
    if (!ONBOARDING_TRANSITIONS[record.status].includes("BLOCKED")) return;
    this.db
      .prepare("update onboarding_records set status = 'BLOCKED', revision = ?, last_error = ?, updated_at = ? where record_id = ? and revision = ?")
      .run(record.revision + 1, sanitizeError(reason), this.now(), record.recordId, record.revision);
  }

  private rememberIdempotency(
    key: string,
    merchantId: string,
    requestDigest: string,
    recordId: string,
  ): void {
    this.db
      .prepare(
        "insert or ignore into onboarding_idempotency (idempotency_key, merchant_id, request_digest, record_id, created_at)"
          + " values (?, ?, ?, ?, ?)",
      )
      .run(key, merchantId, requestDigest, recordId, this.now());
  }

  private recordEvidence(recordId: string, evidence: Evidence): void {
    const authoritative = isAuthoritative(evidence);
    const summary =
      evidence.kind === "platform_query"
        ? `applicationId=${evidence.applicationId} generation=${evidence.generation} source=${evidence.source}`
        : evidence.summary;
    this.db
      .prepare(
        "insert into onboarding_evidence (evidence_id, record_id, kind, authoritative, summary, observed_at, created_at)"
          + " values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `ev_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        recordId,
        evidence.kind,
        authoritative ? 1 : 0,
        sanitizeError(summary),
        evidence.observedAt,
        this.now(),
      );
  }

  private nextGeneration(merchantId: string): number {
    const row = this.db
      .prepare("select max(generation) as max_generation from onboarding_records where merchant_id = ?")
      .get(merchantId) as { max_generation: number | null } | undefined;
    return (row?.max_generation ?? 0) + 1;
  }

  /**
   * 从旧版仅有 records 的数据库建立“当前槽”指针。只选每个槽位最新的一条非终态
   * 记录；即使历史上已经发生双插，也不会把两条都恢复成当前写者。
   */
  private backfillSlots(): void {
    this.db.exec(`
      insert or ignore into onboarding_slots
        (merchant_id, environment, agent_slot, current_record_id, generation, updated_at)
      select r.merchant_id, r.environment, r.agent_slot, r.record_id, r.generation, r.updated_at
      from onboarding_records r
      where r.status <> 'CANCELLED'
        and r.record_id = (
          select r2.record_id from onboarding_records r2
          where r2.merchant_id = r.merchant_id
            and r2.environment = r.environment
            and r2.agent_slot = r.agent_slot
            and r2.status <> 'CANCELLED'
          order by r2.generation desc, r2.updated_at desc, r2.record_id desc
          limit 1
        )
    `);
  }

  private requireRecord(recordId: string): OnboardingRecord {
    const record = this.getRecord(recordId);
    if (record === undefined) {
      throw new OnboardingError("record_not_found", `unknown onboarding record: ${recordId}`);
    }
    return record;
  }
}

/** 证据摘要/错误信息脱敏：去掉常见密钥形状，并截断（审计里不留长文本）。 */
export function sanitizeError(value: string): string {
  return String(value ?? "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-key]")
    .replace(/\b(Bearer|token|api[_-]?key|secret|password)\b\s*[:=]?\s*\S+/gi, "$1 [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted-long-token]")
    .slice(0, 500);
}

function requireNonEmpty(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (text === "") {
    throw new OnboardingError("invalid_input", `${field} must be a non-empty string`);
  }
  return text;
}

function assertRevision(record: OnboardingRecord, expected: number): void {
  if (record.revision !== expected) {
    throw new OnboardingError(
      "stale_revision",
      `record ${record.recordId} is at revision ${record.revision}, expected ${expected}`,
    );
  }
}

function assertTransition(from: OnboardingStatus, to: OnboardingStatus): void {
  // 同状态重入是幂等的（重复提交同一步不该报错），除此之外必须走合法迁移。
  if (from === to) return;
  if (!ONBOARDING_TRANSITIONS[from].includes(to)) {
    throw new OnboardingError(
      "illegal_transition",
      `illegal onboarding transition: ${from} → ${to}`,
    );
  }
}

function toRecord(row: Record<string, unknown>): OnboardingRecord {
  return {
    recordId: String(row["record_id"]),
    intentId: String(row["intent_id"]),
    merchantId: String(row["merchant_id"]),
    environment: "production",
    agentSlot: "primary",
    generation: Number(row["generation"]),
    catalogAgentId: String(row["catalog_agent_id"]),
    cardUrl: String(row["card_url"]),
    versionDigest: String(row["version_digest"]),
    applicationId: row["application_id"] === null ? null : String(row["application_id"]),
    runtimeOriginHost:
      row["runtime_origin_host"] === null ? null : String(row["runtime_origin_host"]),
    status: String(row["status"]) as OnboardingStatus,
    revision: Number(row["revision"]),
    lastSuccessfulStep:
      row["last_successful_step"] === null ? null : String(row["last_successful_step"]),
    lastError: row["last_error"] === null ? null : String(row["last_error"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

/** 便捷构造权威证据（调用方仍必须提供真实回执字段）。 */
export function platformEvidence(input: {
  applicationId: string;
  generation: number;
  source: string;
  observedAt?: string;
}): AuthoritativeEvidence {
  return {
    kind: "platform_query",
    applicationId: input.applicationId,
    generation: input.generation,
    source: input.source,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}
