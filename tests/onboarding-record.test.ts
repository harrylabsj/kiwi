/**
 * M4 开通记录与状态机（设计 §7.1/§7.2/§7.3）。
 *
 * 逐条对上验收用例：
 *   T029 伪造平台回执 —— 文本 applicationId / LLM 的"已完成"**不能**形成平台归属结论；
 *   T008 重复点击       —— 并发提交同一意图 + 同幂等键只产生一个生产槽；
 *   T009 activate 响应丢失 —— 先查询相同意图，复用原 applicationId；
 *   T010 开通中退出返回 —— 读服务端记录续办，且**先查平台**（不依赖会话记忆）；
 *   T011 发布 ID 不一致 —— 阻断并进 BLOCKED，不带错 applicationId 继续；
 *   T012 额度不足       —— 首次不发布；暂停/撤回安全动作仍可用（状态层面）。
 *
 * 这一层是**确定性**的：平台适配器只产证据，不产状态。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  OnboardingError,
  PLATFORM_CAPABILITIES,
  PlatformCapabilityUnavailableError,
  isAuthoritative,
  isPublishable,
} from "../src/cloud/onboarding/types.js";
import { OnboardingStore, digestOf, platformEvidence, sanitizeError } from "../src/cloud/onboarding/store.js";

function store(): OnboardingStore {
  return new OnboardingStore(new DatabaseSync(":memory:"));
}

function open(overrides: Record<string, unknown> = {}) {
  return {
    merchantId: "merchant-onb-1",
    intentId: "intent-1",
    versionDigest: "sha256:" + "a".repeat(64),
    idempotencyKey: "key-1",
    requestDigest: digestOf({ intent: "intent-1", version: "1.0.0" }),
    ...overrides,
  } as Parameters<OnboardingStore["openIntent"]>[0];
}

describe("T029：只有权威证据能推进状态", () => {
  it("文本 applicationId 与 LLM 的「已完成」不能形成平台归属结论", () => {
    const s = store();
    const record = s.openIntent(open());
    expect(record.status).toBe("DRAFT");
    expect(record.applicationId).toBeNull();

    // 商家授权等待 → 允许（还没碰平台）
    s.advance({
      recordId: record.recordId,
      expectedRevision: 0,
      nextStatus: "AWAITING_PLATFORM_CONSENT",
      step: "consent",
    });

    for (const claim of [
      { kind: "text_claim" as const, summary: '用户粘贴："appId=wbapp_FAKE123"', observedAt: "2026-09-21T00:00:00Z" },
      { kind: "text_claim" as const, summary: 'LLM: "已部署完成，一切正常"', observedAt: "2026-09-21T00:00:01Z" },
      { kind: "adapter_return" as const, summary: "activate() 返回 200，未见平台回执", observedAt: "2026-09-21T00:00:02Z" },
    ]) {
      expect(() =>
        s.advance({
          recordId: record.recordId,
          expectedRevision: 1,
          nextStatus: "ACTIVATED",
          evidence: claim,
        }),
      ).toThrow(OnboardingError);
    }

    const after = s.getRecord(record.recordId);
    expect(after?.status).toBe("AWAITING_PLATFORM_CONSENT");
    expect(after?.applicationId).toBeNull();
    // 但三条都被留痕了（审计要能看到"有人说它完成了"）
    const evidence = s.evidenceFor(record.recordId);
    expect(evidence.filter((e) => !e.authoritative)).toHaveLength(3);
  });

  it("platform_query 回执是唯一能让 ACTIVE 生效、并写入 applicationId 的路径", () => {
    const s = store();
    const record = s.openIntent(open());
    s.advance({ recordId: record.recordId, expectedRevision: 0, nextStatus: "AWAITING_PLATFORM_CONSENT" });
    const activated = s.advance({
      recordId: record.recordId,
      expectedRevision: 1,
      nextStatus: "ACTIVATED",
      step: "platform-consent",
      evidence: platformEvidence({
        applicationId: "wbapp_REAL1",
        generation: 1,
        source: "inspectOwnedApplication",
      }),
    });
    expect(activated.status).toBe("ACTIVATED");
    expect(activated.applicationId).toBe("wbapp_REAL1");
    expect(s.evidenceFor(record.recordId).some((e) => e.authoritative)).toBe(true);
  });

  it("自洽性不足的「查询回执」不算权威（缺来源/缺时间/空 applicationId）", () => {
    expect(
      isAuthoritative({ kind: "platform_query", applicationId: "x", generation: 1, source: "", observedAt: "t" }),
    ).toBe(false);
    expect(
      isAuthoritative({ kind: "platform_query", applicationId: "", generation: 1, source: "s", observedAt: "t" }),
    ).toBe(false);
    expect(
      isAuthoritative({ kind: "platform_query", applicationId: "x", generation: 1, source: "s", observedAt: "" }),
    ).toBe(false);
  });
});

describe("T007：平台确认框被拒绝", () => {
  it("拒绝授权 → **保持等待**，绝不显示已开通，也不代确认", () => {
    const s = store();
    const record = s.openIntent(open());
    const awaiting = s.advance({
      recordId: record.recordId,
      expectedRevision: 0,
      nextStatus: "AWAITING_PLATFORM_CONSENT",
      step: "login-binding",
    });
    const refused = s.recordConsentRefused(awaiting.recordId, awaiting.revision, {
      note: "商家在平台确认框点了拒绝",
    });
    // 状态不变：还在等；没有 applicationId；也没有被写成 ACTIVE
    expect(refused.status).toBe("AWAITING_PLATFORM_CONSENT");
    expect(refused.applicationId).toBeNull();
    expect(refused.revision).toBe(awaiting.revision + 1);
    expect(refused.lastError).toContain("拒绝");
    // 拒绝这件事被留痕（审计能看到"商家拒绝了"，而不是含糊的"未知失败"）
    const evidence = s.evidenceFor(record.recordId);
    expect(evidence.some((e) => e.summary.includes("consent refused"))).toBe(true);
    expect(evidence.every((e) => !e.authoritative)).toBe(true);
  });

  it("拒绝后商家仍可重新授权，也可撤销意图", () => {
    const s = store();
    const record = s.openIntent(open());
    let current = s.advance({
      recordId: record.recordId,
      expectedRevision: 0,
      nextStatus: "AWAITING_PLATFORM_CONSENT",
    });
    current = s.recordConsentRefused(current.recordId, current.revision);
    // 重新授权：权威回执到达 → 正常推进
    const activated = s.advance({
      recordId: current.recordId,
      expectedRevision: current.revision,
      nextStatus: "ACTIVATED",
      evidence: platformEvidence({ applicationId: "wbapp_AGAIN", generation: 1, source: "inspectOwnedApplication" }),
    });
    expect(activated.status).toBe("ACTIVATED");

    // 另一条路：拒绝后直接撤销
    const other = s.openIntent(open({ merchantId: "merchant-onb-2", idempotencyKey: "key-2" }));
    const waiting = s.advance({
      recordId: other.recordId,
      expectedRevision: 0,
      nextStatus: "AWAITING_PLATFORM_CONSENT",
    });
    expect(s.cancel(waiting.recordId, waiting.revision).status).toBe("CANCELLED");
  });

  it("不在等待授权时记录「拒绝」是非法调用（不能把别处的失败伪装成商家拒绝）", () => {
    const s = store();
    const record = s.openIntent(open());
    expect(() => s.recordConsentRefused(record.recordId, 0)).toThrow(/awaiting platform consent/);
  });
});

describe("T008/T009：重复点击与响应丢失", () => {
  it("同幂等键 + 同请求摘要 → 返回同一条记录，不新建", () => {
    const s = store();
    const first = s.openIntent(open());
    const second = s.openIntent(open());
    expect(second.recordId).toBe(first.recordId);
    expect(s.activeRecord("merchant-onb-1")?.recordId).toBe(first.recordId);
  });

  it("同幂等键 + 不同请求摘要 → 冲突（不静默复用）", () => {
    const s = store();
    s.openIntent(open());
    expect(() =>
      s.openIntent(open({ requestDigest: digestOf({ something: "else" }) })),
    ).toThrow(/different request digest/);
  });

  it("换幂等键但同商家 → 仍返回同一活跃记录（重复点击的另一种形态）", () => {
    const s = store();
    const first = s.openIntent(open({ idempotencyKey: "key-a" }));
    const second = s.openIntent(open({ idempotencyKey: "key-b" }));
    expect(second.recordId).toBe(first.recordId);
    expect(second.generation).toBe(1);
  });

  it("activate 响应丢失后重试：复用原 applicationId（不重新 create）", () => {
    const s = store();
    const record = s.openIntent(open());
    s.advance({ recordId: record.recordId, expectedRevision: 0, nextStatus: "AWAITING_PLATFORM_CONSENT" });
    const activated = s.advance({
      recordId: record.recordId,
      expectedRevision: 1,
      nextStatus: "ACTIVATED",
      evidence: platformEvidence({ applicationId: "wbapp_KEEP", generation: 1, source: "inspectOwnedApplication" }),
    });

    // 客户端超时后重试：同一意图再开一次
    const retried = s.openIntent(open());
    expect(retried.recordId).toBe(activated.recordId);
    expect(retried.applicationId).toBe("wbapp_KEEP");
  });

  it("显式新建部署代次才会产生新记录（换版本/重建环境）", () => {
    const s = store();
    const first = s.openIntent(open());
    const second = s.openIntent(open({ idempotencyKey: "key-new", newGeneration: true }));
    expect(second.recordId).not.toBe(first.recordId);
    expect(second.generation).toBe(2);
    expect(s.activeRecord("merchant-onb-1")?.recordId).toBe(second.recordId);
  });

  it("两个数据库连接共享唯一当前槽；取消新代次不会复活旧写者", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-onboarding-slot-"));
    const dbPath = path.join(dir, "state.sqlite");
    const firstDb = new DatabaseSync(dbPath);
    const secondDb = new DatabaseSync(dbPath);
    try {
      const firstStore = new OnboardingStore(firstDb);
      const secondStore = new OnboardingStore(secondDb);
      const original = firstStore.openIntent(open({ idempotencyKey: "slot-a" }));
      const reused = secondStore.openIntent(open({ idempotencyKey: "slot-b" }));
      expect(reused.recordId).toBe(original.recordId);

      const replacement = firstStore.openIntent(
        open({ idempotencyKey: "slot-next", newGeneration: true }),
      );
      expect(replacement.generation).toBe(2);
      expect(secondStore.activeRecord("merchant-onb-1")?.recordId).toBe(replacement.recordId);

      firstStore.cancel(replacement.recordId, replacement.revision);
      // 旧代次记录仍用于审计，但当前槽已经清空；绝不把旧写者重新提升为活动代次。
      expect(secondStore.getRecord(original.recordId)?.status).toBe("DRAFT");
      expect(secondStore.activeRecord("merchant-onb-1")).toBeUndefined();
      const slots = secondDb
        .prepare("select count(*) as count from onboarding_slots where merchant_id = ?")
        .get("merchant-onb-1") as { count: number };
      expect(slots.count).toBe(0);
    } finally {
      firstDb.close();
      secondDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T010：读服务端记录续办，且必须先查平台", () => {
  it("resumeContext 指向最后成功步骤，并强制先查平台", () => {
    const s = store();
    const record = s.openIntent(open());
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
      evidence: platformEvidence({ applicationId: "wbapp_X", generation: 1, source: "inspectOwnedApplication" }),
    });
    s.advance({ recordId: record.recordId, expectedRevision: 2, nextStatus: "DEPLOYING", step: "deploy-start" });

    // "新的进程/新的会话"重开向导：只凭商家身份就能读到记录（不依赖会话记忆）
    const resume = s.resumeContext("merchant-onb-1");
    expect(resume?.record.status).toBe("DEPLOYING");
    expect(resume?.resumeFromStep).toBe("deploy-start");
    expect(resume?.requiresPlatformQuery).toBe(true);
  });

  it("记录是**落盘的**：换一个进程/新的 store 实例也读得到（不依赖会话记忆）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-onboarding-"));
    const dbPath = path.join(dir, "state.sqlite");
    try {
      const first = new OnboardingStore(new DatabaseSync(dbPath));
      const record = first.openIntent(open());
      first.advance({
        recordId: record.recordId,
        expectedRevision: 0,
        nextStatus: "AWAITING_PLATFORM_CONSENT",
        step: "login-binding",
      });
      first.advance({
        recordId: record.recordId,
        expectedRevision: 1,
        nextStatus: "ACTIVATED",
        step: "platform-consent",
        evidence: platformEvidence({ applicationId: "wbapp_DISK", generation: 1, source: "inspectOwnedApplication" }),
      });
      first.cancel(record.recordId, 2); // 关闭前留一条终态，确认状态本身也落盘
      (first as unknown as { db: DatabaseSync }).db.close();

      // "重新打开 Buddy"：新实例、同一个库
      const second = new OnboardingStore(new DatabaseSync(dbPath));
      const reopened = second.getRecord(record.recordId);
      expect(reopened?.status).toBe("CANCELLED");
      expect(reopened?.applicationId).toBe("wbapp_DISK");
      expect(reopened?.lastSuccessfulStep).toBe("platform-consent");
      expect(second.evidenceFor(record.recordId).some((e) => e.authoritative)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("没有任何记录时 resumeContext 返回 undefined（不凭记忆编一条出来）", () => {
    const s = store();
    expect(s.resumeContext("merchant-never-opened")).toBeUndefined();
  });
});

describe("T011：applicationId 不一致必须阻断", () => {
  it("平台报告不同 applicationId → 记录进 BLOCKED 且抛 application_id_mismatch", () => {
    const s = store();
    const record = s.openIntent(open());
    s.advance({ recordId: record.recordId, expectedRevision: 0, nextStatus: "AWAITING_PLATFORM_CONSENT" });
    s.advance({
      recordId: record.recordId,
      expectedRevision: 1,
      nextStatus: "ACTIVATED",
      evidence: platformEvidence({ applicationId: "wbapp_FIRST", generation: 1, source: "inspectOwnedApplication" }),
    });

    expect(() =>
      s.advance({
        recordId: record.recordId,
        expectedRevision: 2,
        nextStatus: "DEPLOYING",
        evidence: platformEvidence({ applicationId: "wbapp_OTHER", generation: 1, source: "inspectOwnedApplication" }),
      }),
    ).toThrow(/applicationId wbapp_OTHER, record holds wbapp_FIRST/);

    const blocked = s.getRecord(record.recordId);
    expect(blocked?.status).toBe("BLOCKED");
    expect(blocked?.applicationId).toBe("wbapp_FIRST"); // 绝不改写为错误的那一个
    expect(blocked?.lastError).toContain("different applicationId");
  });

  it("BLOCKED 后不能直接跳到发布态（必须先解除原因）", () => {
    const s = store();
    const record = s.openIntent(open());
    s.fail(record.recordId, 0, { reason: "quota exhausted", retryable: false });
    expect(s.getRecord(record.recordId)?.status).toBe("BLOCKED");
    expect(() =>
      s.advance({ recordId: record.recordId, expectedRevision: 1, nextStatus: "DEPLOYING" }),
    ).toThrow(/illegal onboarding transition/);
  });
});

describe("T012：额度不足", () => {
  it("首次开通遇配额不足 → 停在可重试失败，绝不发布", () => {
    const s = store();
    const record = s.openIntent(open());
    s.advance({ recordId: record.recordId, expectedRevision: 0, nextStatus: "AWAITING_PLATFORM_CONSENT" });
    const failed = s.fail(record.recordId, 1, {
      reason: "platform quota exhausted (activate rejected)",
      retryable: true,
    });
    expect(failed.status).toBe("FAILED_RETRYABLE");
    expect(isPublishable(failed.status)).toBe(false);
    expect(
      ["PUBLISHED", "READY_TO_PUBLISH"].includes(s.getRecord(record.recordId)?.status ?? ""),
    ).toBe(false);
  });

  it("暂停/撤回这类安全动作在非发布态也可用（撤销意图不被「先发布」挡住）", () => {
    const s = store();
    const record = s.openIntent(open());
    const cancelled = s.cancel(record.recordId, 0);
    expect(cancelled.status).toBe("CANCELLED");
    // 撤销是终态：不再占用活跃记录名额
    expect(s.activeRecord("merchant-onb-1")).toBeUndefined();
  });
});

describe("§7.1/§7.2：CAS、并发与唯一性", () => {
  it("过期 revision 被拒（并发写不互相覆盖）", () => {
    const s = store();
    const record = s.openIntent(open());
    s.advance({ recordId: record.recordId, expectedRevision: 0, nextStatus: "AWAITING_PLATFORM_CONSENT" });
    expect(() =>
      s.advance({ recordId: record.recordId, expectedRevision: 0, nextStatus: "FAILED_RETRYABLE" }),
    ).toThrow(/revision 1, expected 0/);
  });

  it("创建意图时就预留 catalog_agent_id 与稳定 Card URL（此时不可营业）", () => {
    const s = store();
    const record = s.openIntent(open());
    expect(record.catalogAgentId).toBe("cagt_intent-1");
    expect(record.cardUrl).toBe("/v1/agents/cagt_intent-1/agent-card.json");
    expect(isPublishable(record.status)).toBe(false);
  });

  it("只有 PUBLISHED 可营业", () => {
    for (const status of ["DRAFT", "BOUND", "VERIFYING", "READY_TO_PUBLISH", "BLOCKED"] as const) {
      expect(isPublishable(status)).toBe(false);
    }
    expect(isPublishable("PUBLISHED")).toBe(true);
  });

  it("invalid_input：空商家/意图/幂等键一律拒绝", () => {
    const s = store();
    for (const bad of [
      { merchantId: " " },
      { intentId: "" },
      { idempotencyKey: "" },
      { requestDigest: "" },
    ]) {
      expect(() => s.openIntent(open(bad))).toThrow(OnboardingError);
    }
  });

  it("审计摘要脱敏：密钥形状与长 token 不进错误/证据文本", () => {
    const s = store();
    const record = s.openIntent(open());
    s.fail(record.recordId, 0, {
      reason: 'deploy failed with token=abcd1234secret and key -----BEGIN PRIVATE KEY-----AAAA-----END PRIVATE KEY----- ' + "x".repeat(60),
      retryable: true,
    });
    const stored = s.getRecord(record.recordId)?.lastError ?? "";
    expect(stored).not.toContain("abcd1234secret");
    expect(stored).not.toContain("BEGIN PRIVATE KEY");
    expect(stored).toContain("[redacted");
    expect(sanitizeError("y".repeat(900)).length).toBeLessThanOrEqual(500);
  });
});

describe("§7.3：平台适配器只定义能力，未映射的禁止成功空实现", () => {
  it("能力清单与设计逐条一致", () => {
    expect([...PLATFORM_CAPABILITIES]).toEqual([
      "inspectOwnedApplication",
      "activateWithUserConsent",
      "deployPinnedArtifact",
      "getDeploymentStatus",
      "readVerifiedPublicConfig",
      "getRuntimePublicOrigin",
      "requestStop",
      "requestDelete",
    ]);
  });

  it("未映射能力抛 PLATFORM_CAPABILITY_UNAVAILABLE（不是静默成功）", () => {
    const err = new PlatformCapabilityUnavailableError("requestDelete");
    expect(err.code).toBe("PLATFORM_CAPABILITY_UNAVAILABLE");
    expect(err.capability).toBe("requestDelete");
    expect(err.message).toContain("not mapped");
  });
});
