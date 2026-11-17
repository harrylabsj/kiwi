/**
 * TOP1-3 M5：64 条验收证据登记/完整性。
 * passed 必须有版本、输入/预期/实际、执行人和 trace/对象/回执；pending 不得
 * 填实际结果；只有 64 条全部 passed 才允许发布门通过。
 */
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_CASE_IDS,
  EvidenceError,
  assertEvidenceComplete,
  summarizeEvidence,
  validateEvidenceRecord,
  type EvidenceCaseId,
  type EvidenceRecord,
} from "../src/merchant-core/operations-jobs/pilot-evidence.js";

function passedRecord(case_id: EvidenceCaseId): EvidenceRecord {
  return {
    case_id,
    status: "passed",
    commit_sha: "366ef681",
    package_version: "0.12.30",
    schema_version: "m5-suite-v1",
    config_version: "m0-pilot-1",
    deploy_mode: "isolated-fixture",
    input_digest: "sha256:input",
    expected: "预期",
    actual: "实际",
    trace_ref: "trace-1",
    executor: "pilot-runner",
    executed_at: "2026-11-17T10:00:00.000Z",
  };
}

describe("M5 验收证据", () => {
  it("64 个用例 ID 唯一且完整", () => {
    expect(EVIDENCE_CASE_IDS).toHaveLength(64);
    expect(new Set(EVIDENCE_CASE_IDS).size).toBe(64);
    expect(EVIDENCE_CASE_IDS[0]).toBe("A01");
    expect(EVIDENCE_CASE_IDS.at(-1)).toBe("X12");
  });

  it("pending 不得填写 actual；passed 必须可追溯", () => {
    expect(() =>
      validateEvidenceRecord({
        case_id: "A01",
        status: "pending",
        actual: "假装通过",
      }),
    ).toThrowError(EvidenceError);
    expect(() =>
      validateEvidenceRecord({ case_id: "A01", status: "passed", actual: "x" }),
    ).toThrow(/缺少 commit_sha/);
    const record = passedRecord("A01");
    expect(validateEvidenceRecord(record)).toEqual(record);
    expect(() =>
      validateEvidenceRecord({ ...record, trace_ref: undefined }),
    ).toThrow(/trace_ref/);
  });

  it("汇总：缺项/失败/跳过均不 complete；全部 passed 才 complete", () => {
    const pending = EVIDENCE_CASE_IDS.map((caseId) => ({
      case_id: caseId,
      status: "pending" as const,
    }));
    const summary = summarizeEvidence(pending);
    expect(summary).toMatchObject({
      total: 64,
      pending: 64,
      passed: 0,
      complete: false,
      missing: [],
    });
    const partial = pending.map((record) =>
      record.case_id === "A01" ? passedRecord("A01") : record,
    );
    expect(summarizeEvidence(partial)).toMatchObject({ passed: 1, pending: 63, complete: false });

    const allPassed = EVIDENCE_CASE_IDS.map((caseId) => passedRecord(caseId));
    expect(summarizeEvidence(allPassed).complete).toBe(true);
    expect(assertEvidenceComplete(allPassed).passed).toBe(64);
  });

  it("重复登记/未知 ID 拒绝；未完成时发布门列出阻塞项", () => {
    const record = passedRecord("A01");
    expect(() => summarizeEvidence([record, record])).toThrow(/重复/);
    expect(() =>
      validateEvidenceRecord({ case_id: "Z99" as EvidenceCaseId, status: "pending" }),
    ).toThrow(/未知验收用例/);
    const missing = EVIDENCE_CASE_IDS.slice(1).map((caseId) => passedRecord(caseId));
    try {
      assertEvidenceComplete(missing);
      expect.unreachable("应拒绝未完成证据");
    } catch (err) {
      expect(err).toBeInstanceOf(EvidenceError);
      expect((err as EvidenceError).reason).toBe("evidence_incomplete");
      expect((err as EvidenceError).message).toContain("A01");
    }
  });
});
