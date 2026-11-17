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
 * 64 条验收证据登记与完整性校验（设计 v1.1 §22.2 / 附录 A / M5）。
 *
 * 只登记可追溯证据：`passed` 必须同时有版本、输入/预期、实际结果、执行人/
 * 时间，以及 trace/持久对象/回执至少一项；缺证据的 `passed` 一律拒绝。
 * 未执行必须显式 `pending`，不能用测试数量或 fake provider 结果填空。
 */

export const EVIDENCE_CASE_IDS = [
  ...Array.from({ length: 20 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 16 }, (_, index) => `B${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 16 }, (_, index) => `C${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `X${String(index + 1).padStart(2, "0")}`),
] as const;
export type EvidenceCaseId = (typeof EVIDENCE_CASE_IDS)[number];

export const EVIDENCE_STATUSES = ["pending", "passed", "failed", "skipped"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export interface EvidenceRecord {
  readonly case_id: EvidenceCaseId;
  readonly status: EvidenceStatus;
  readonly commit_sha?: string;
  readonly package_version?: string;
  readonly model_version?: string;
  readonly schema_version?: string;
  readonly config_version?: string;
  readonly deploy_mode?: string;
  readonly input_digest?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly trace_ref?: string;
  readonly object_ref?: string;
  readonly receipt_ref?: string;
  readonly executor?: string;
  readonly executed_at?: string;
  readonly notes?: string;
}

export interface EvidenceSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
  readonly missing: readonly EvidenceCaseId[];
  readonly complete: boolean;
}

const CASE_ID_SET: ReadonlySet<string> = new Set(EVIDENCE_CASE_IDS);
const NON_EMPTY = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim() !== "";

export class EvidenceError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "EvidenceError";
    this.reason = reason;
  }
}

/** 校验单条证据；`passed` 缺任一可追溯字段即拒绝。 */
export function validateEvidenceRecord(record: EvidenceRecord): EvidenceRecord {
  if (!CASE_ID_SET.has(record.case_id)) {
    throw new EvidenceError("case_id_unknown", `未知验收用例 ${String(record.case_id)}`);
  }
  if (!(EVIDENCE_STATUSES as readonly string[]).includes(record.status)) {
    throw new EvidenceError("status_unknown", `未知证据状态 ${String(record.status)}`);
  }
  if (record.status === "passed") {
    const required: Array<[keyof EvidenceRecord, string]> = [
      ["commit_sha", "commit_sha"],
      ["package_version", "package_version"],
      ["schema_version", "schema_version"],
      ["config_version", "config_version"],
      ["deploy_mode", "deploy_mode"],
      ["input_digest", "input_digest"],
      ["expected", "expected"],
      ["actual", "actual"],
      ["executor", "executor"],
      ["executed_at", "executed_at"],
    ];
    for (const [key, label] of required) {
      if (!NON_EMPTY(record[key] as string | undefined)) {
        throw new EvidenceError("passed_evidence_incomplete", `passed 证据缺少 ${label}`);
      }
    }
    if (![record.trace_ref, record.object_ref, record.receipt_ref].some(NON_EMPTY)) {
      throw new EvidenceError(
        "passed_evidence_incomplete",
        "passed 证据至少需要 trace_ref / object_ref / receipt_ref 之一",
      );
    }
  }
  if (record.status === "pending" && NON_EMPTY(record.actual)) {
    throw new EvidenceError("pending_has_actual", "pending 用例不得填写实际结果");
  }
  return record;
}

/** 汇总证据：缺项显式列出；只有 64 条全部 passed 才算 complete。 */
export function summarizeEvidence(records: readonly EvidenceRecord[]): EvidenceSummary {
  const seen = new Map<EvidenceCaseId, EvidenceStatus>();
  for (const record of records) {
    validateEvidenceRecord(record);
    if (seen.has(record.case_id)) {
      throw new EvidenceError("case_id_duplicate", `用例 ${record.case_id} 重复登记`);
    }
    seen.set(record.case_id, record.status);
  }
  const missing = EVIDENCE_CASE_IDS.filter((caseId) => !seen.has(caseId));
  const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const status of seen.values()) counts[status] += 1;
  return {
    total: EVIDENCE_CASE_IDS.length,
    ...counts,
    missing,
    complete:
      missing.length === 0 &&
      counts.passed === EVIDENCE_CASE_IDS.length,
  };
}

/** 发布门：任一非 passed 都拒绝；返回按组统计。 */
export function assertEvidenceComplete(records: readonly EvidenceRecord[]): EvidenceSummary {
  const summary = summarizeEvidence(records);
  if (!summary.complete) {
    const blocked = EVIDENCE_CASE_IDS.filter((caseId) => {
      const record = records.find((item) => item.case_id === caseId);
      return record === undefined || record.status !== "passed";
    });
    throw new EvidenceError(
      "evidence_incomplete",
      `验收证据未完成：passed=${summary.passed}/${summary.total}；未通过或缺失：${blocked.join(",")}`,
    );
  }
  return summary;
}
