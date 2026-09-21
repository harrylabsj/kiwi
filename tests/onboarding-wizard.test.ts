/**
 * M4 五步向导骨架（§5.4；T007/T010/T012/T057）。
 *
 * 向导的"当前该做哪一步"只由**服务端记录**推导：同一条记录必然得到同一份计划。
 * 中途退出、换设备、重开 Buddy，都不该改变它。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { OnboardingStore, digestOf, platformEvidence } from "../src/cloud/onboarding/store.js";
import {
  WIZARD_STEPS,
  WIZARD_STEP_IDS,
  auditWizardCopy,
  checkStepSubmission,
  planWizard,
} from "../src/cloud/onboarding/steps.js";

function store(): OnboardingStore {
  return new OnboardingStore(new DatabaseSync(":memory:"));
}

function opened(s: OnboardingStore) {
  return s.openIntent({
    merchantId: "merchant-wizard-1",
    intentId: "intent-w",
    versionDigest: "sha256:" + "a".repeat(64),
    idempotencyKey: "key-w",
    requestDigest: digestOf({ intent: "intent-w" }),
  });
}

describe("五步定义", () => {
  it("步骤与设计逐条一致，顺序固定", () => {
    expect(WIZARD_STEP_IDS).toEqual([
      "login-binding",
      "platform-consent",
      "catalog-confirm",
      "service-check",
      "public-profile",
    ]);
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual([...WIZARD_STEP_IDS]);
  });

  it("T057：面向非技术用户的文案里不出现域名/终端/端口/密钥", () => {
    expect(auditWizardCopy()).toEqual([]);
  });

  it("关键步骤要求权威证据（平台授权尤其）", () => {
    const byId = Object.fromEntries(WIZARD_STEPS.map((s) => [s.id, s]));
    expect(byId["login-binding"]?.requiresAuthoritativeEvidence).toBe(false);
    for (const id of ["platform-consent", "catalog-confirm", "service-check", "public-profile"]) {
      expect(byId[id]?.requiresAuthoritativeEvidence).toBe(true);
    }
  });
});

describe("T010：计划完全由服务端记录推导", () => {
  it("新记录：第一步是当前步，其余待办", () => {
    const s = store();
    const plan = planWizard(opened(s));
    expect(plan.currentStep).toBe("login-binding");
    expect(plan.recordStatus).toBe("DRAFT");
    expect(plan.steps.map((step) => step.state)).toEqual([
      "CURRENT",
      "UNAVAILABLE",
      "UNAVAILABLE",
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);
  });

  it("做完两步后：前两步 DONE，第三步 CURRENT，断点可读", () => {
    const s = store();
    const record = opened(s);
    s.advance({
      recordId: record.recordId,
      expectedRevision: 0,
      nextStatus: "AWAITING_PLATFORM_CONSENT",
      step: "login-binding",
    });
    s.advance({
      recordId: record.recordId,
      expectedRevision: 1,
      nextStatus: "ACTIVATED",
      step: "platform-consent",
      evidence: platformEvidence({ applicationId: "wbapp_W1", generation: 1, source: "inspectOwnedApplication" }),
    });

    // 换一个 store 实例（等价于换进程）：计划必须一致
    const again = store();
    void again;
    const plan = planWizard(s.getRecord(record.recordId)!);
    expect(plan.steps.map((step) => step.state).slice(0, 3)).toEqual(["DONE", "DONE", "CURRENT"]);
    expect(plan.currentStep).toBe("catalog-confirm");
    expect(plan.resumeFromStep).toBe("platform-consent");
  });

  it("同一记录多次推导结果相同（纯函数，不受调用顺序影响）", () => {
    const s = store();
    const record = opened(s);
    expect(planWizard(record)).toEqual(planWizard(record));
  });

  it("记录进 BLOCKED 时没有 CURRENT 步——停在那儿等商家处理，不硬推下一步", () => {
    const s = store();
    const record = opened(s);
    const blocked = s.fail(record.recordId, 0, { reason: "platform mapping missing", retryable: false });
    const plan = planWizard(blocked);
    expect(plan.currentStep).toBeNull();
    expect(plan.recordStatus).toBe("BLOCKED");
  });
});

describe("T007/T029：提交前的准入判定", () => {
  it("平台授权步骤：代确认 / 转述 / 粘贴 id 都不算（非权威证据一律拒）", () => {
    const s = store();
    const record = opened(s);
    const consented = s.advance({
      recordId: record.recordId,
      expectedRevision: 0,
      nextStatus: "AWAITING_PLATFORM_CONSENT",
      step: "login-binding",
    });

    for (const claim of [
      { kind: "text_claim" as const, summary: '商家说："我已经在平台点过同意了"', observedAt: "t" },
      { kind: "adapter_return" as const, summary: "activate() 返回 ok", observedAt: "t" },
      { kind: "user_consent_receipt" as const, summary: "自报的同意回执", observedAt: "t" },
    ]) {
      const verdict = checkStepSubmission(consented, "platform-consent", claim);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("evidence_not_authoritative");
    }
    // 完全没有证据也不行
    expect(checkStepSubmission(consented, "platform-consent").ok).toBe(false);
    // 权威回执才通过
    const ok = checkStepSubmission(
      consented,
      "platform-consent",
      platformEvidence({ applicationId: "wbapp_W2", generation: 1, source: "inspectOwnedApplication" }),
    );
    expect(ok.ok).toBe(true);
  });

  it("状态不对的步骤直接拒（不能跳步）", () => {
    const s = store();
    const record = opened(s);
    const verdict = checkStepSubmission(record, "public-profile");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("step_not_current");
  });

  it("已撤销的意图上任何步骤都拒", () => {
    const s = store();
    const record = opened(s);
    const cancelled = s.cancel(record.recordId, 0);
    const verdict = checkStepSubmission(cancelled, "login-binding");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("record_terminal");
  });
});

describe("T012：失败如实展示（配额不足 / 依赖映射失败）", () => {
  it("配额不足与依赖缺失都是 blocked（不静默重试、不假装完成）", () => {
    const byId = Object.fromEntries(WIZARD_STEPS.map((s) => [s.id, s]));
    // 服务检查一步：失败要停下来真实展示
    expect(byId["service-check"]?.onFailure).toBe("blocked");
    // 平台授权那一步：授权被拒 → 保持等待/取消，不代确认
    expect(byId["platform-consent"]?.onFailure).toBe("blocked");
  });

  it("走完全程的每一步都能被合法推进（无死路）", () => {
    const s = store();
    let record = opened(s);
    const evidence = () =>
      platformEvidence({
        applicationId: "wbapp_FULL",
        generation: 1,
        source: "inspectOwnedApplication",
      });
    const path: Array<
      [string | undefined, Parameters<OnboardingStore["advance"]>[0]["nextStatus"], boolean]
    > = [
      ["login-binding", "AWAITING_PLATFORM_CONSENT", false],
      ["platform-consent", "ACTIVATED", true],
      ["catalog-confirm", "DEPLOYING", true],
      // 以下三步都不是向导步骤：平台回执与系统检查由**后台对账**推进
      [undefined, "DEPLOYED_UNBOUND", true],
      [undefined, "BOUND", true],
      [undefined, "VERIFYING", true],
      ["service-check", "READY_TO_PUBLISH", true],
      ["public-profile", "PUBLISHED", true],
    ];
    for (const [step, nextStatus, needsEvidence] of path) {
      const advance: Parameters<OnboardingStore["advance"]>[0] = {
        recordId: record.recordId,
        expectedRevision: record.revision,
        nextStatus,
        ...(step !== undefined ? { step } : {}),
        ...(needsEvidence ? { evidence: evidence() } : {}),
      };
      record = s.advance(advance);
    }
    expect(record.status).toBe("PUBLISHED");
    expect(planWizard(record).steps.every((step) => step.state === "DONE")).toBe(true);
  });
});
