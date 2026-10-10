/**
 * review P1-2 回归：委托约束（limits）对 accept 类动作真正生效 +
 * ASK 审批的任务/候选绑定与一次性消费。
 *
 * 结构化说明：候选无结构化价格（provenance.reply_text 文本承载）——
 * 价格约束走文本解析（negotiator 同款口径），解析不出 fail-closed deny。
 */
import { describe, expect, it } from "vitest";

import { buildBuyerService } from "../src/buyer-core/build-service.js";
import type { TaskApprovalStore } from "../src/buyer-core/store.js";
import type { KiwiBuyerService } from "../src/buyer-core/service.js";

function makeService(acceptMode: "auto" | "ask", policyLimits?: Record<string, unknown>): KiwiBuyerService {
  return buildBuyerService({
    dbPath: ":memory:",
    principal: "company:limits-test",
    buyerAgentId: "buyer-agent:limits",
    sessionId: "limits-session",
    policy: {
      policy_id: "dp-limits",
      version: "1.0",
      principal: "company:limits-test",
      expires_at: "2099-12-31T23:59:59Z",
      actions: {
        discover: { mode: "auto" },
        inquiry_rfq: { mode: "auto" },
        compare_offers: { mode: "auto" },
        counter_offer: { mode: "auto" },
        accept_nonbinding: { mode: acceptMode },
        handoff: { mode: "ask" },
        payment: { mode: "never" },
      },
      ...(policyLimits !== undefined ? { limits: policyLimits } : {}),
    } as never,
  });
}

interface StoreSlice {
  addCandidate(taskId: string, candidate: Record<string, unknown>): void;
  listCandidates(taskId: string): Array<Record<string, unknown>>;
}

function storeOf(service: KiwiBuyerService): StoreSlice {
  return (service as unknown as { store: TaskApprovalStore }).store as unknown as StoreSlice;
}

async function seedTask(service: KiwiBuyerService, idempotencyKey: string): Promise<string> {
  const { task } = await service.requestQuotes({
    intent: {
      intent_id: "int-limits",
      intent_type: "purchase",
      items: [{ query: "扩展坞", quantity: { value: 10, unit: "个" } }],
    },
    merchant_ids: ["merchant_ok"],
    idempotency_key: idempotencyKey,
  });
  return (task as { task_id: string }).task_id;
}

function addQuotedCandidate(
  service: KiwiBuyerService,
  taskId: string,
  candidateId: string,
  merchantId: string,
  terms: {
    currency: string;
    items: Array<{ sku: string; quantity_value: number; quantity_unit?: string; unit_price_minor: number }>;
    total_price_minor: number;
  } | undefined,
): void {
  storeOf(service).addCandidate(taskId, {
    candidate_id: candidateId,
    merchant_id: merchantId,
    status: "succeeded",
    provenance: { reply_text: "structured facts only (P1-2 返修)" },
    ...(terms !== undefined ? { terms } : {}),
    retryable: false,
  });
}

/** 单明细报价（quantity 可为小数——KNP number>0）；total = unit×qty。 */
function singleItemTerms(
  unitPriceMinor: number,
  quantityValue: number,
  currency = "CNY",
  unit = "台",
) {
  return {
    currency,
    items: [{ sku: "dock-1", quantity_value: quantityValue, quantity_unit: unit, unit_price_minor: unitPriceMinor }],
    total_price_minor: unitPriceMinor * quantityValue,
  };
}

describe("limits 真正约束 accept（review P1-2，auto 模式直测授权层）", () => {
  it("allowed_merchants 之外的候选 → merchant_hard_policy denied", async () => {
    const service = makeService("auto", { allowed_merchants: ["merchant_a"] });
    const taskId = await seedTask(service, "k-am");
    addQuotedCandidate(service, taskId, "cand_b", "merchant_b", singleItemTerms(10_000, 1));
    await expect(
      service.acceptAgreement({ task_id: taskId, candidate_id: "cand_b" }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("max_unit_price 之上 → denied；之下 → 允许", async () => {
    const denied = makeService("auto", { max_unit_price: { currency: "CNY", amount_minor: 18_000 } });
    const taskIdD = await seedTask(denied, "k-up-d");
    addQuotedCandidate(denied, taskIdD, "cand", "merchant_ok", singleItemTerms(18_900, 1));
    await expect(
      denied.acceptAgreement({ task_id: taskIdD, candidate_id: "cand" }),
    ).rejects.toMatchObject({ code: "authorization_denied" });

    const allowed = makeService("auto", { max_unit_price: { currency: "CNY", amount_minor: 20_000 } });
    const taskIdA = await seedTask(allowed, "k-up-a");
    addQuotedCandidate(allowed, taskIdA, "cand", "merchant_ok", singleItemTerms(18_900, 1));
    const result = await allowed.acceptAgreement({ task_id: taskIdA, candidate_id: "cand" });
    expect(result.authorization.effective_decision).toBe("granted");
  });

  it("max_total_price（明细合计）之上 → denied", async () => {
    const service = makeService("auto", { max_total_price: { currency: "CNY", amount_minor: 100_000 } });
    const taskId = await seedTask(service, "k-tp");
    // 1.5 × 99900 = 149850（小数数量合法，money 恒整数 minor）
    addQuotedCandidate(service, taskId, "cand", "merchant_ok", singleItemTerms(99_900, 1.5, "CNY", "台"));
    await expect(
      service.acceptAgreement({ task_id: taskId, candidate_id: "cand" }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("无结构化报价事实 + 价格上限存在 → fail-closed denied", async () => {
    const service = makeService("auto", { max_unit_price: { currency: "CNY", amount_minor: 999_999 } });
    const taskId = await seedTask(service, "k-np");
    addQuotedCandidate(service, taskId, "cand", "merchant_ok", undefined);
    await expect(
      service.acceptAgreement({ task_id: taskId, candidate_id: "cand" }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("allowed_currencies 之外的币种 → denied", async () => {
    const service = makeService("auto", { allowed_currencies: ["USD"] });
    const taskId = await seedTask(service, "k-cur");
    addQuotedCandidate(service, taskId, "cand", "merchant_ok", singleItemTerms(10_000, 1, "CNY"));
    await expect(
      service.acceptAgreement({ task_id: taskId, candidate_id: "cand" }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });
});

describe("P1-2 A316 补充校准：币种/单位/总量/counter 闸口", () => {
  it("投影拒混币种（每行与 total 币种一致才接受）", async () => {
    const { projectOfferTerms } = await import("../src/buyer-core/a2a-quote-fetcher.js");
    const mixed = {
      type: "offer",
      offer_id: "o1",
      terms: {
        currency: "CNY",
        items: [
          { sku: "a", quantity: { value: 1, unit: "个" }, unit_price: { amount_minor: 100, currency: "CNY" } },
          { sku: "b", quantity: { value: 2, unit: "个" }, unit_price: { amount_minor: 200, currency: "USD" } },
        ],
      },
    };
    expect(projectOfferTerms(mixed)).toBeUndefined();
    const totalMismatch = {
      type: "offer",
      offer_id: "o2",
      terms: {
        currency: "CNY",
        items: [{ sku: "a", quantity: { value: 1, unit: "个" }, unit_price: { amount_minor: 100, currency: "CNY" } }],
        total_price: { amount_minor: 100, currency: "USD" },
      },
    };
    expect(projectOfferTerms(totalMismatch)).toBeUndefined();
    const uniform = {
      type: "offer",
      offer_id: "o3",
      terms: {
        currency: "CNY",
        items: [
          { sku: "a", quantity: { value: 1, unit: "个" }, unit_price: { amount_minor: 100, currency: "CNY" } },
          { sku: "b", quantity: { value: 2, unit: "个" }, unit_price: { amount_minor: 200, currency: "CNY" } },
        ],
        total_price: { amount_minor: 500, currency: "CNY" },
      },
    };
    expect(projectOfferTerms(uniform)).toMatchObject({ currency: "CNY", total_price_minor: 500 });
  });

  it("声明限额单位时，明细缺 quantity_unit → 拒（不得视为匹配）", async () => {
    const service = makeService("auto", { max_quantity: { value: 5, unit: "台" } });
    const taskId = await seedTask(service, "k-unit");
    storeOf(service).addCandidate(taskId, {
      candidate_id: "cand",
      merchant_id: "merchant_ok",
      status: "succeeded",
      provenance: {},
      terms: { currency: "CNY", items: [{ sku: "dock-1", quantity_value: 2, unit_price_minor: 100 }], total_price_minor: 200 },
      retryable: false,
    });
    await expect(
      service.acceptAgreement({ task_id: taskId, candidate_id: "cand" }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("max_quantity 按总量聚合：两行各 6、上限 10 → 拒（合计 12）", async () => {
    const service = makeService("auto", { max_quantity: { value: 10, unit: "个" } });
    const taskId = await seedTask(service, "k-total");
    storeOf(service).addCandidate(taskId, {
      candidate_id: "cand",
      merchant_id: "merchant_ok",
      status: "succeeded",
      provenance: {},
      terms: {
        currency: "CNY",
        items: [
          { sku: "a", quantity_value: 6, quantity_unit: "个", unit_price_minor: 100 },
          { sku: "b", quantity_value: 6, quantity_unit: "个", unit_price_minor: 100 },
        ],
        total_price_minor: 1200,
      },
      retryable: false,
    });
    await expect(
      service.acceptAgreement({ task_id: taskId, candidate_id: "cand" }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });
});

describe("ASK 审批绑定与一次性消费（review P1-2）", () => {
  it("批准后 accept 成功 → 审批 used；同审批再 handoff → denied", async () => {
    const service = makeService("ask");
    const taskId = await seedTask(service, "k-ask-1");
    addQuotedCandidate(service, taskId, "cand", "merchant_ok", singleItemTerms(10_000, 1));
    const digest = JSON.stringify(
      storeOf(service).listCandidates(taskId).find((c) => c.candidate_id === "cand"),
    );
    // digest 绑定值以 contentDigest 口径为准——直接用候选对象的内容摘要。
    const { contentDigest } = await import("../src/negotiation/jcs.js");
    const bound = contentDigest(
      storeOf(service).listCandidates(taskId).find((c) => c.candidate_id === "cand") as never,
    );
    expect(bound).toBeTruthy();
    void digest;

    // 第一次调用 → approval_required（digest 已绑定到审批）。
    const approvalId = await service.acceptAgreement({ task_id: taskId, candidate_id: "cand" })
      .then(() => undefined)
      .catch((err: { detail?: { approval_id?: string } }) => {
        if (err.detail?.approval_id === undefined) throw err;
        return err.detail.approval_id;
      });
    expect(typeof approvalId).toBe("string");
    service.approve({ approval_id: approvalId as string });
    const done = await service.acceptAgreement({
      task_id: taskId,
      candidate_id: "cand",
      approval_id: approvalId as string,
    });
    expect(done.agreement.agreement_id).toMatch(/^agreement-/);

    // 一次性：同一审批再 handoff → denied（used）。
    const agreementId = (done.agreement as { agreement_id: string }).agreement_id;
    await expect(
      service.handoff({ agreement_id: agreementId, approval_id: approvalId as string, destination_type: "cart" }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("他任务的审批不能授权本任务（task 绑定）", async () => {
    const service = makeService("ask");
    const taskA = await seedTask(service, "k-x-a");
    const taskB = await seedTask(service, "k-x-b");
    addQuotedCandidate(service, taskA, "cand_a", "merchant_ok", singleItemTerms(100, 1));
    addQuotedCandidate(service, taskB, "cand_b", "merchant_ok", singleItemTerms(100, 1));
    const { contentDigest } = await import("../src/negotiation/jcs.js");
    const digestB = contentDigest(
      storeOf(service).listCandidates(taskB).find((c) => c.candidate_id === "cand_b") as never,
    );
    const { approval_id } = service.requestApproval({ task_id: taskB, action: "accept_nonbinding", candidate_digest: digestB });
    service.approve({ approval_id });
    await expect(
      service.acceptAgreement({ task_id: taskA, candidate_id: "cand_a", approval_id: approval_id }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("同绑定重放返回同一 agreement；换候选拒绝（P1-2 返修）", async () => {
    const service = makeService("ask");
    const taskId = await seedTask(service, "k-replay");
    addQuotedCandidate(service, taskId, "cand", "merchant_ok", singleItemTerms(10_000, 1));
    addQuotedCandidate(service, taskId, "cand2", "merchant_ok", singleItemTerms(11_000, 1));
    const { contentDigest } = await import("../src/negotiation/jcs.js");
    const digest = contentDigest(
      storeOf(service).listCandidates(taskId).find((c) => c.candidate_id === "cand") as never,
    );
    const { approval_id } = service.requestApproval({ task_id: taskId, action: "accept_nonbinding", candidate_digest: digest });
    service.approve({ approval_id });
    const first = await service.acceptAgreement({ task_id: taskId, candidate_id: "cand", approval_id });
    // 同逻辑重放：同一审批 + 同候选 + 同摘要 → 同一 agreement（效果恰一次）
    const replay = await service.acceptAgreement({ task_id: taskId, candidate_id: "cand", approval_id });
    expect((replay.agreement as { agreement_id: string }).agreement_id).toBe(
      (first.agreement as { agreement_id: string }).agreement_id,
    );
    // 换候选（不同摘要）→ 拒绝（在候选绑定层即拒，authorization_denied）
    await expect(
      service.acceptAgreement({ task_id: taskId, candidate_id: "cand2", approval_id }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("纯本地写失败补偿：审批不烧毁，同绑定重试可再入（P1-2 返修）", async () => {
    const service = makeService("ask");
    const taskId = await seedTask(service, "k-comp");
    addQuotedCandidate(service, taskId, "cand", "merchant_ok", singleItemTerms(10_000, 1));
    const { contentDigest } = await import("../src/negotiation/jcs.js");
    const digest = contentDigest(
      storeOf(service).listCandidates(taskId).find((c) => c.candidate_id === "cand") as never,
    );
    const { approval_id } = service.requestApproval({ task_id: taskId, action: "accept_nonbinding", candidate_digest: digest });
    service.approve({ approval_id });
    // 注入 store 故障：updateTask 抛错（agreement 已落、消费未完成）
    const store = storeOf(service) as unknown as { updateTask: () => never; };
    const real = store.updateTask;
    const svcStore = (service as unknown as { store: Record<string, unknown> }).store;
    const realUpdate = svcStore.updateTask as (...a: unknown[]) => unknown;
    svcStore.updateTask = () => {
      throw new Error("injected local write failure");
    };
    await expect(
      service.acceptAgreement({ task_id: taskId, candidate_id: "cand", approval_id }),
    ).rejects.toThrow("injected local write failure");
    // 补偿：无部分 agreement 残留；审批仍 approved（未烧毁）
    expect(storeOf(service).listCandidates(taskId).length).toBeGreaterThan(0);
    const approval = (svcStore.getApproval as (...a: unknown[]) => { status: string })(approval_id);
    expect(approval.status).toBe("approved");
    // 恢复后同绑定重试成功
    svcStore.updateTask = realUpdate;
    const retry = await service.acceptAgreement({ task_id: taskId, candidate_id: "cand", approval_id });
    expect((retry.agreement as { agreement_id: string }).agreement_id).toMatch(/^agreement-/);
    void store; void real;
  });

  it("审批 digest 与当前候选不一致 → denied（候选绑定）", async () => {
    const service = makeService("ask");
    const taskId = await seedTask(service, "k-dg");
    addQuotedCandidate(service, taskId, "cand_x", "merchant_ok", singleItemTerms(100, 1));
    addQuotedCandidate(service, taskId, "cand_y", "merchant_ok", singleItemTerms(200, 1));
    const { contentDigest } = await import("../src/negotiation/jcs.js");
    const digestX = contentDigest(
      storeOf(service).listCandidates(taskId).find((c) => c.candidate_id === "cand_x") as never,
    );
    const { approval_id } = service.requestApproval({ task_id: taskId, action: "accept_nonbinding", candidate_digest: digestX });
    service.approve({ approval_id });
    await expect(
      service.acceptAgreement({ task_id: taskId, candidate_id: "cand_y", approval_id: approval_id }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });
});
