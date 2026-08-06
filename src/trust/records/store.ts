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
 * trust/records — TrustRecordStore：CounterpartyTrustRecord 持久化 + 观察聚合
 * （基线 §27 / §28 / WP1）。
 *
 * 观察是事实，评估是结论，两者分离：
 *   - observe(observation)：append 一条事实观察，只改事实面；trust_level /
 *     rejected 由评估器重新推导，observe 本身无法直接写结论（TrustObservation
 *     没有 level 字段）。
 *   - evaluate(identity)：对已落盘记录按当前事实 + 部署配置重新推导并落盘结论。
 *
 * 持久化（对齐 idempotency/ledger 的原子写）：目录 0700、文件 0600；写采用
 * 同目录临时文件（wx + fsync）+ rename，要么旧记录完整，要么新记录完整，永不撕裂。
 * 读侧校验记录形状，损坏记录返回 null（→ 对端视为未知 T0，fail-closed）。
 *
 * Agent Card 指纹变更检测：observe 发现携带指纹与已存指纹不同时产生告警信号
 * （fingerprintChanged），并持久化 fingerprint_changes 计数 —— 即使调用方错过
 * 返回值，重启后 get() 也能发现身份锚发生过变更（不是静默接受）。
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { sha256Hex } from "../../negotiation/jcs.js";
import { isTrustLevel } from "../identity/trust-policy.js";
import { evaluateTrustRecord } from "./evaluator.js";
import type { EvaluationResult, EvaluateOptions } from "./evaluator.js";
import { DISPUTE_CLASSIFICATIONS, TRUST_RECORD_SCHEMA_VERSION } from "./types.js";
import type {
  CounterpartyTrustRecord,
  DisputeClassification,
  DisputeRecord,
  TrustObservation,
} from "./types.js";

export interface TrustRecordStoreOptions {
  /** 基础数据目录；记录落在 `<dir>/trust/`。 */
  dir: string;
  /** 可注入时钟（RFC 3339）；缺省用 new Date().toISOString()。 */
  now?: () => string;
  /** 评估器配置（阈值 / establishedRelationships / reputation 来源）。 */
  evaluator?: EvaluateOptions;
}

export interface ObservationResult {
  /** 更新后的完整 record（含新推导的结论）。 */
  record: CounterpartyTrustRecord;
  /** 本次评估结论。 */
  evaluation: EvaluationResult;
  /** Agent Card 指纹是否变化（告警信号；持久化于 fingerprint_changes）。 */
  fingerprintChanged: boolean;
  previousFingerprint?: string;
  currentFingerprint?: string;
}

export interface EvaluateResult {
  record: CounterpartyTrustRecord;
  evaluation: EvaluationResult;
}

let tmpSeq = 0;

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isStringMap(v: unknown): v is Record<string, string> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string")
  );
}

function isDisputeRecord(v: unknown): v is DisputeRecord {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.dispute_id === "string" &&
    typeof d.occurred_at === "string" &&
    typeof d.classification === "string" &&
    (DISPUTE_CLASSIFICATIONS as readonly string[]).includes(d.classification)
  );
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function appendDispute(
  existing: DisputeRecord[],
  input: TrustObservation,
  observedAt: string,
): DisputeRecord[] {
  const classification: DisputeClassification = input.dispute?.classification ?? "local_asserted";
  const reason = input.dispute?.reason;
  const disputeId =
    input.dispute?.dispute_id ??
    `dispute-${sha256Hex(`${input.counterparty_identity}|${classification}|${reason ?? ""}|${observedAt}`)}`;
  const index = existing.findIndex((d) => d.dispute_id === disputeId);
  if (index !== -1) {
    // 同 id 观察：只做状态更新（如 resolved/reason），不重复追加。
    const current = existing[index]!;
    const next = [...existing];
    next[index] = {
      ...current,
      ...(input.dispute?.resolved !== undefined ? { resolved: input.dispute.resolved } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    return next;
  }
  const entry: DisputeRecord = { dispute_id: disputeId, classification, occurred_at: observedAt };
  if (reason !== undefined) entry.reason = reason;
  if (input.dispute?.resolved !== undefined) entry.resolved = input.dispute.resolved;
  return [...existing, entry];
}

export class TrustRecordStore {
  private readonly baseDir: string;
  private readonly trustDir: string;
  private readonly now: () => string;
  private readonly evaluator: EvaluateOptions;

  constructor(options: TrustRecordStoreOptions) {
    this.baseDir = options.dir;
    this.trustDir = path.join(options.dir, "trust");
    this.now = options.now ?? (() => new Date().toISOString());
    this.evaluator = options.evaluator ?? {};
  }

  private ensureTrustDir(): string {
    mkdirSync(this.trustDir, { recursive: true, mode: 0o700 });
    chmodSync(this.trustDir, 0o700);
    return this.trustDir;
  }

  /** 对端身份 → 安全文件名：`trust-<sha256(identity)>.json`（身份在文件内自描述）。 */
  private filePathFor(identity: string): string {
    const dir = this.ensureTrustDir();
    return path.resolve(dir, `trust-${sha256Hex(identity)}.json`);
  }

  /** 原子写（对齐 supervisor/manifest.ts：同目录临时文件 + fsync + rename，0600）。 */
  private writeFileAtomic(filePath: string, record: CounterpartyTrustRecord): void {
    const tmp = `${filePath}.tmp-${process.pid}-${++tmpSeq}`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
  }

  /**
   * 读取并校验记录；缺失或形状非法返回 null。损坏记录视同未知（对端回到 T0）：
   * fail-closed —— 宁可信得少，不可把结论建立在被破坏的记录上。
   */
  private readRecord(identity: string): CounterpartyTrustRecord | null {
    const filePath = this.filePathFor(identity);
    if (!existsSync(filePath)) return null;
    return this.parseRecord(filePath);
  }

  private parseRecord(filePath: string): CounterpartyTrustRecord | null {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    if (
      typeof r.counterparty_identity !== "string" ||
      r.counterparty_identity.length === 0 ||
      typeof r.first_seen !== "string" ||
      typeof r.last_seen !== "string" ||
      typeof r.evaluated_at !== "string" ||
      !isTrustLevel(r.trust_level) ||
      !isCount(r.successful_exchanges) ||
      !isCount(r.consecutive_verified_exchanges) ||
      !isCount(r.invalid_schema_count) ||
      !isCount(r.timeout_count) ||
      !isCount(r.replay_detected_count) ||
      !isCount(r.signature_failure_count) ||
      !isCount(r.fingerprint_changes) ||
      r.schema_version !== TRUST_RECORD_SCHEMA_VERSION ||
      !Array.isArray(r.local_asserted_disputes) ||
      !r.local_asserted_disputes.every(isDisputeRecord) ||
      !isStringMap(r.capability_versions)
    ) {
      return null;
    }
    return {
      counterparty_identity: r.counterparty_identity,
      domain: optionalString(r.domain),
      agent_card_fingerprint: optionalString(r.agent_card_fingerprint),
      provider: optionalString(r.provider),
      capability_versions: r.capability_versions as Record<string, string>,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      last_fingerprint_change_at: optionalString(r.last_fingerprint_change_at),
      successful_exchanges: r.successful_exchanges,
      consecutive_verified_exchanges: r.consecutive_verified_exchanges,
      invalid_schema_count: r.invalid_schema_count,
      timeout_count: r.timeout_count,
      replay_detected_count: r.replay_detected_count,
      signature_failure_count: r.signature_failure_count,
      local_asserted_disputes: r.local_asserted_disputes as DisputeRecord[],
      fingerprint_changes: r.fingerprint_changes,
      schema_version: TRUST_RECORD_SCHEMA_VERSION,
      trust_level: r.trust_level,
      evaluated_at: r.evaluated_at,
      rejected: typeof r.rejected === "boolean" ? r.rejected : false,
      rejection_reason: optionalString(r.rejection_reason),
    };
  }

  /** 读取记录；未知/损坏返回 null。 */
  get(identity: string): CounterpartyTrustRecord | null {
    return this.readRecord(identity);
  }

  /** 是否存在记录。 */
  has(identity: string): boolean {
    return this.readRecord(identity) !== null;
  }

  /** 所有已落账的对端身份。 */
  list(): string[] {
    const dir = this.ensureTrustDir();
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("trust-") || !name.endsWith(".json")) continue;
      const record = this.parseRecord(path.join(dir, name));
      if (record !== null) out.push(record.counterparty_identity);
    }
    return out;
  }

  /** 删除记录；不存在返回 false。 */
  remove(identity: string): boolean {
    const filePath = this.filePathFor(identity);
    if (!existsSync(filePath)) return false;
    rmSync(filePath);
    return true;
  }

  /**
   * 追加一条事实观察并落盘。只改事实面；结论由评估器重新推导（评估得出而非自填）。
   * 指纹与已存不同 → 返回 fingerprintChanged 告警，并持久化计数。
   */
  observe(input: TrustObservation): ObservationResult {
    const identity = input.counterparty_identity;
    if (identity.length === 0) {
      throw new TypeError("TrustRecordStore.observe: counterparty_identity must be non-empty");
    }
    const observedAt = input.observed_at ?? this.now();
    const existing = this.readRecord(identity);

    const record: CounterpartyTrustRecord = existing ?? {
      counterparty_identity: identity,
      domain: undefined,
      agent_card_fingerprint: undefined,
      provider: undefined,
      capability_versions: {},
      first_seen: observedAt,
      last_seen: observedAt,
      successful_exchanges: 0,
      consecutive_verified_exchanges: 0,
      invalid_schema_count: 0,
      timeout_count: 0,
      replay_detected_count: 0,
      signature_failure_count: 0,
      local_asserted_disputes: [],
      fingerprint_changes: 0,
      schema_version: TRUST_RECORD_SCHEMA_VERSION,
      trust_level: "T0",
      evaluated_at: observedAt,
      rejected: false,
    };

    if (Date.parse(observedAt) < Date.parse(record.first_seen)) record.first_seen = observedAt;
    if (Date.parse(observedAt) > Date.parse(record.last_seen)) record.last_seen = observedAt;
    if (input.domain !== undefined && record.domain === undefined) record.domain = input.domain;
    if (input.provider !== undefined && record.provider === undefined)
      record.provider = input.provider;

    // Agent Card 指纹变更检测（identity 锚；告警而非静默接受）。
    let fingerprintChanged = false;
    const previousFingerprint = record.agent_card_fingerprint;
    if (input.agent_card_fingerprint !== undefined) {
      if (record.agent_card_fingerprint === undefined) {
        record.agent_card_fingerprint = input.agent_card_fingerprint;
      } else if (record.agent_card_fingerprint !== input.agent_card_fingerprint) {
        fingerprintChanged = true;
        record.fingerprint_changes += 1;
        record.last_fingerprint_change_at = observedAt;
        record.agent_card_fingerprint = input.agent_card_fingerprint;
        // 身份锚变更：先前的验签连续性不再适用于新 identity 材料。
        record.consecutive_verified_exchanges = 0;
      }
    }

    switch (input.kind) {
      case "exchange_success":
        record.successful_exchanges += 1;
        record.consecutive_verified_exchanges += 1;
        if (input.capability_versions !== undefined) {
          record.capability_versions = {
            ...record.capability_versions,
            ...input.capability_versions,
          };
        }
        break;
      case "schema_invalid":
        record.invalid_schema_count += 1;
        break;
      case "timeout":
        record.timeout_count += 1;
        break;
      case "replay_detected":
        record.replay_detected_count += 1;
        record.consecutive_verified_exchanges = 0;
        break;
      case "signature_failure":
        record.signature_failure_count += 1;
        record.consecutive_verified_exchanges = 0;
        break;
      case "dispute":
        record.local_asserted_disputes = appendDispute(
          record.local_asserted_disputes,
          input,
          observedAt,
        );
        break;
    }

    // 结论只由评估器推导。
    const evaluation = evaluateTrustRecord(record, this.evaluator);
    record.trust_level = evaluation.level;
    record.rejected = evaluation.rejected;
    record.rejection_reason = evaluation.rejected ? evaluation.reason : undefined;
    record.evaluated_at = observedAt;

    this.writeFileAtomic(this.filePathFor(identity), record);
    return {
      record,
      evaluation,
      fingerprintChanged,
      ...(fingerprintChanged
        ? { previousFingerprint, currentFingerprint: record.agent_card_fingerprint }
        : {}),
    };
  }

  /**
   * 对已落盘记录重新推导结论并落盘（如部署配置 establishedRelationships 变化后
   * 重新评估）。只改结论，不改事实。无记录返回 null。
   */
  evaluate(identity: string): EvaluateResult | null {
    const record = this.readRecord(identity);
    if (record === null) return null;
    const evaluation = evaluateTrustRecord(record, this.evaluator);
    record.trust_level = evaluation.level;
    record.rejected = evaluation.rejected;
    record.rejection_reason = evaluation.rejected ? evaluation.reason : undefined;
    record.evaluated_at = this.now();
    this.writeFileAtomic(this.filePathFor(identity), record);
    return { record, evaluation };
  }
}
