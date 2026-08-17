/**
 * kiwi-buyer-mcp 薄 facade 测试（战略 v2.5 §6.1/§6.2/§5.5/§6.10）。
 *
 * 覆盖：
 *  - 服务流程：requestQuotes（幂等/部分失败）→ getTask → negotiate → accept →
 *    getAgreement → handoff；
 *  - 五层授权 deny-wins（approval_required / 动作不匹配 / deny 优先）；
 *  - host-context isolation（只存 intent，无环境上下文泄漏）；
 *  - UCP/KNP boundary conformance（只暴露 7 个高层工具，无 UCP/raw-KNP 工具）；
 *  - MCP server 协议面：initialize 版本 fail-closed、未初始化拒绝、未知工具、
 *    未知方法、解析错误；
 *  - 重启后 pending/approval 可解释（持久 store 重新打开）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertNorthboundContractValid } from "../src/contracts/northbound-schema.js";
import {
  KiwiBuyerService,
  type AuthorizationRecord,
  type MerchantIndex,
  type QuoteFetcher,
} from "../src/buyer-core/service.js";
import { McpServer } from "../src/mcp/server.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { buildKiwiTools } from "../src/mcp/tools.js";
import { KIWI_SOURCING_TOOLS, MCP_PROTOCOL_VERSIONS } from "../src/mcp/types.js";

const TS = "2026-08-15T10:00:00+08:00";

const POLICY = {
  policy_id: "dp-test-001",
  version: "1.0",
  principal: "company:acme-test",
  created_at: TS,
  expires_at: "2026-09-15T10:00:00+08:00",
  actions: {
    discover: { mode: "auto" },
    inquiry_rfq: { mode: "auto" },
    compare_offers: { mode: "auto" },
    counter_offer: { mode: "auto", note: "受限 AUTO" },
    accept_nonbinding: { mode: "ask" },
    handoff: { mode: "ask" },
    payment: { mode: "never" },
  },
  limits: { max_rounds: 2, allowed_currencies: ["CNY"] },
};

const INTENT = {
  intent_id: "intent-test-0001",
  intent_type: "purchase",
  items: [{ query: "USB-C 扩展坞", sku: "dock-1", quantity: { value: 2, unit: "台" } }],
  constraints: {
    budget: { currency: "CNY", amount_minor: 100000 },
    currency: "CNY",
    delivery_location: "杭州",
    deadline: "2026-08-30T18:00:00+08:00",
  },
  context_projection: {
    disclosure_boundary: "commerce_required",
    projected_fields: ["items", "constraints"],
  },
};

const MERCHANTS: MerchantIndex = {
  async search(query) {
    return [
      { merchant_id: "merchant-001", name: "商家甲", verified: true, category: "it", region: "杭州", capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"] },
      { merchant_id: "merchant-002", name: "商家乙", verified: false, category: "it", region: "上海", capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"] },
    ].filter((m) => query === "" || m.name.includes(query));
  },
  async resolveById(merchantId) {
    return [
      { merchant_id: "merchant-001", name: "商家甲", verified: true, category: "it", region: "杭州", capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"] },
      { merchant_id: "merchant-002", name: "商家乙", verified: false, category: "it", region: "上海", capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"] },
    ].find((m) => m.merchant_id === merchantId);
  },
};

function fakeQuoteFetcher(): QuoteFetcher {
  return {
    async requestQuotes(_intent, merchants) {
      return merchants.map((m, i) =>
        i === 0
          ? {
              merchant_id: m.merchant_id,
              status: "succeeded" as const,
              provenance: {
                merchant_reply_id: `reply-${m.merchant_id}`,
                negotiation_id: `neg-${m.merchant_id}`,
                offer_id: `offer-${m.merchant_id}`,
                source: "a2a",
              },
            }
          : {
              merchant_id: m.merchant_id,
              status: "failed" as const,
              failure: { classification: "timeout" as const, retryable: true },
            },
      );
    },
  };
}

interface Harness {
  service: KiwiBuyerService;
  store: TaskApprovalStore;
  policy: typeof POLICY;
}

function makeHarness(store: TaskApprovalStore, policy: Record<string, unknown> = POLICY): Harness {
  const service = new KiwiBuyerService({
    store,
    principal: "company:acme-test",
    buyerAgentId: "buyer-agent:test",
    sessionId: "session-test-1",
    delegationPolicy: policy,
    merchantIndex: MERCHANTS,
    quoteFetcher: fakeQuoteFetcher(),
  });
  return { service, store, policy: policy as typeof POLICY };
}

function makeInMemoryStore(): TaskApprovalStore {
  return new TaskApprovalStore({ dbPath: ":memory:" });
}

function grantedAuthorization(approvalId: string): AuthorizationRecord {
  return {
    authorization_id: "authz-test-1",
    action: "accept_nonbinding",
    subject: {
      buyer_agent_id: "buyer-agent:test",
      session_id: "session-test-1",
      delegation_id: POLICY.policy_id,
      expires_at: POLICY.expires_at,
    },
    layers: {
      package_trust: { status: "allowed" },
      host_tool_policy: { status: "allowed" },
      runtime_approval: { status: "allowed" },
      kiwi_delegation_policy: { status: "allowed" },
      merchant_hard_policy: { status: "allowed" },
    },
    effective_decision: "granted",
    approval_id: approvalId,
    expires_at: POLICY.expires_at,
    decided_at: TS,
  };
}

describe("KiwiBuyerService：requestQuotes 幂等与部分失败", () => {
  it("合法 CommerceIntent 创建任务并回写候选（partial_success + provenance）", async () => {
    const { service, store } = makeHarness(makeInMemoryStore());
    const result = await service.requestQuotes({
      intent: INTENT,
      idempotency_key: "rfq-k1",
      merchant_ids: ["merchant-001", "merchant-002"],
    });
    expect(result.created).toBe(true);
    const task = result.task as Record<string, unknown>;
    expect(task.task_kind).toBe("request_quotes");
    expect(task.status).toBe("partial_success");
    expect(task.idempotency_key).toBe("rfq-k1");
    const candidates = task.candidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(2);
    const succeeded = candidates.find((c) => c.merchant_id === "merchant-001");
    expect(succeeded?.status).toBe("succeeded");
    expect((succeeded?.provenance as { merchant_reply_id?: string })?.merchant_reply_id).toBe(
      "reply-merchant-001",
    );
    expect(store.getTask(String(task.task_id))).toBeDefined();
  });

  it("相同 idempotency_key 重复提交返回原任务（不重复写入）", async () => {
    const { service } = makeHarness(makeInMemoryStore());
    const first = await service.requestQuotes({ intent: INTENT, idempotency_key: "rfq-dedup" });
    const second = await service.requestQuotes({ intent: INTENT, idempotency_key: "rfq-dedup" });
    expect(second.created).toBe(false);
    expect(second.task.task_id).toBe(first.task.task_id);
  });

  it("非法 CommerceIntent（缺 items）在写库前被拒", async () => {
    const { service } = makeHarness(makeInMemoryStore());
    const bad = { intent_id: "intent-bad", intent_type: "purchase" };
    await expect(
      service.requestQuotes({ intent: bad, idempotency_key: "rfq-bad" }),
    ).rejects.toMatchObject({ code: "contract_violation" });
  });
});

describe("KiwiBuyerService：negotiate 委托边界", () => {
  it("在 max_rounds 内记录磋商步骤", async () => {
    const { service } = makeHarness(makeInMemoryStore());
    const created = await service.requestQuotes({ intent: INTENT, idempotency_key: "rfq-neg" });
    const taskId = String(created.task.task_id);
    const step = await service.negotiate({
      task_id: taskId,
      action: "counter_offer",
      summary: "单价降 5%",
    });
    expect(step.step.round).toBe(1);
    expect((step.task.steps as Array<Record<string, unknown>>)).toHaveLength(1);
  });

  it("超出 max_rounds 被拒（delegation_denied）", async () => {
    const { service } = makeHarness(makeInMemoryStore());
    const created = await service.requestQuotes({ intent: INTENT, idempotency_key: "rfq-rounds" });
    const taskId = String(created.task.task_id);
    await service.negotiate({ task_id: taskId, action: "counter_offer", summary: "r1" });
    await service.negotiate({ task_id: taskId, action: "counter_offer", summary: "r2" });
    await expect(
      service.negotiate({ task_id: taskId, action: "counter_offer", summary: "r3" }),
    ).rejects.toMatchObject({ code: "delegation_denied" });
  });
});

describe("KiwiBuyerService：AcceptNonbinding → Agreement → Handoff（五层授权）", () => {
  it("ask 策略下缺审批返回 approval_required（持久 approval_id）", async () => {
    const { service } = makeHarness(makeInMemoryStore());
    const created = await service.requestQuotes({
      intent: INTENT,
      idempotency_key: "rfq-acc",
      merchant_ids: ["merchant-001", "merchant-002"],
    });
    const taskId = String(created.task.task_id);
    const candidates = created.task.candidates as Array<Record<string, unknown>>;
    const winner = candidates.find((c) => c.status === "succeeded")!;
    await expect(
      service.acceptAgreement({ task_id: taskId, candidate_id: String(winner.candidate_id) }),
    ).rejects.toMatchObject({ code: "approval_required" });
  });

  it("批准后形成非绑定 Agreement（三副作用标志恒 false）", async () => {
    const { service } = makeHarness(makeInMemoryStore());
    const created = await service.requestQuotes({
      intent: INTENT,
      idempotency_key: "rfq-agree",
      merchant_ids: ["merchant-001", "merchant-002"],
    });
    const taskId = String(created.task.task_id);
    const winner = (created.task.candidates as Array<Record<string, unknown>>).find(
      (c) => c.status === "succeeded",
    )!;
    const approval = service.requestApproval({
      task_id: taskId,
      action: "accept_nonbinding",
      candidate_digest: `sha256:${"b".repeat(64)}`,
    });
    service.approveApproval({
      approval_id: approval.approval_id,
      authorization: grantedAuthorization(approval.approval_id),
    });
    const accepted = await service.acceptAgreement({
      task_id: taskId,
      candidate_id: String(winner.candidate_id),
      approval_id: approval.approval_id,
    });
    expect(accepted.agreement.binding_effect).toBe("nonbinding");
    expect(accepted.agreement.creates_order).toBe(false);
    expect(accepted.agreement.authorizes_payment).toBe(false);
    expect(accepted.agreement.reserves_inventory).toBe(false);
    expect(accepted.authorization.effective_decision).toBe("granted");

    const agreementId = String(accepted.agreement.agreement_id);
    const fetched = service.getAgreement(agreementId);
    expect(fetched.agreement.agreement_id).toBe(agreementId);
  });

  it("deny 优先：被拒绝的审批无法形成 Agreement", async () => {
    const { service } = makeHarness(makeInMemoryStore());
    const created = await service.requestQuotes({
      intent: INTENT,
      idempotency_key: "rfq-deny",
      merchant_ids: ["merchant-001", "merchant-002"],
    });
    const taskId = String(created.task.task_id);
    const winner = (created.task.candidates as Array<Record<string, unknown>>).find(
      (c) => c.status === "succeeded",
    )!;
    const approval = service.requestApproval({
      task_id: taskId,
      action: "accept_nonbinding",
    });
    service.rejectApproval({ approval_id: approval.approval_id, reason: "operator 拒绝" });
    await expect(
      service.acceptAgreement({
        task_id: taskId,
        candidate_id: String(winner.candidate_id),
        approval_id: approval.approval_id,
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("approval 动作不匹配被拒（accept 审批不能用于 handoff）", async () => {
    const { service } = makeHarness(makeInMemoryStore());
    const created = await service.requestQuotes({
      intent: INTENT,
      idempotency_key: "rfq-mismatch",
      merchant_ids: ["merchant-001", "merchant-002"],
    });
    const taskId = String(created.task.task_id);
    const winner = (created.task.candidates as Array<Record<string, unknown>>).find(
      (c) => c.status === "succeeded",
    )!;
    const approval = service.requestApproval({ task_id: taskId, action: "accept_nonbinding" });
    service.approveApproval({
      approval_id: approval.approval_id,
      authorization: grantedAuthorization(approval.approval_id),
    });
    const accepted = await service.acceptAgreement({
      task_id: taskId,
      candidate_id: String(winner.candidate_id),
      approval_id: approval.approval_id,
    });
    // handoff 需要动作=handoff 的新审批
    await expect(
      service.handoff({
        agreement_id: String(accepted.agreement.agreement_id),
        approval_id: approval.approval_id,
        destination_type: "external_checkout_url",
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("handoff 需独立 handoff 审批并返回 handoff_ref", async () => {
    const { service } = makeHarness(makeInMemoryStore());
    const created = await service.requestQuotes({
      intent: INTENT,
      idempotency_key: "rfq-handoff",
      merchant_ids: ["merchant-001", "merchant-002"],
    });
    const taskId = String(created.task.task_id);
    const winner = (created.task.candidates as Array<Record<string, unknown>>).find(
      (c) => c.status === "succeeded",
    )!;
    const acceptApproval = service.requestApproval({
      task_id: taskId,
      action: "accept_nonbinding",
    });
    service.approveApproval({
      approval_id: acceptApproval.approval_id,
      authorization: grantedAuthorization(acceptApproval.approval_id),
    });
    const accepted = await service.acceptAgreement({
      task_id: taskId,
      candidate_id: String(winner.candidate_id),
      approval_id: acceptApproval.approval_id,
    });
    const handoffApproval = service.requestApproval({ task_id: taskId, action: "handoff" });
    service.approveApproval({
      approval_id: handoffApproval.approval_id,
      authorization: {
        ...grantedAuthorization(handoffApproval.approval_id),
        action: "handoff",
      },
    });
    const handoff = await service.handoff({
      agreement_id: String(accepted.agreement.agreement_id),
      approval_id: handoffApproval.approval_id,
      destination_type: "external_checkout_url",
      url: "https://merchant-001.example/checkout/xyz",
    });
    expect(handoff.handoff_ref.handoff_id).toBeDefined();
    expect(handoff.handoff_ref.destination_type).toBe("external_checkout_url");
    expect(handoff.handoff_ref.url).toContain("merchant-001");
  });
});

describe("host-context isolation（§5.4 最小披露）", () => {
  it("任务负载只包含投影的 intent，无环境/宿主上下文", async () => {
    const { service } = makeHarness(makeInMemoryStore());
    const created = await service.requestQuotes({ intent: INTENT, idempotency_key: "rfq-isolation" });
    const task = created.task as Record<string, unknown>;
    const intent = task.intent as Record<string, unknown>;
    // 只有 CommerceIntent 进入任务；没有 principal memory / 对话历史 / 宿主工具。
    expect(intent).toEqual(INTENT);
    const keys = Object.keys(task);
    expect(keys).not.toContain("host_memory");
    expect(keys).not.toContain("conversation_history");
    expect(keys).not.toContain("host_tools");
    // 契约校验：带 intent 的持久任务记录仍合法。
    expect(() => assertNorthboundContractValid("persistent-task", task, "task")).not.toThrow();
  });
});

describe("Merchant Discovery（§3.2 kiwi-catalog 驱动）", () => {
  it("catalog 不可达时 kiwi_search 返回可解释 note，不编造商家", async () => {
    const store = makeInMemoryStore();
    const service = new KiwiBuyerService({
      store,
      principal: "company:acme-test",
      buyerAgentId: "buyer-agent:test",
      sessionId: "session-test-1",
      delegationPolicy: POLICY,
      merchantIndex: {
        async search() {
          throw new Error("connection refused");
        },
        async resolveById() {
          throw new Error("connection refused");
        },
      },
    });
    const result = await service.search({ query: "扩展坞" });
    expect(result.merchants).toEqual([]);
    expect(result.note).toContain("unreachable");
  });

  it("KiwiCatalogMerchantIndex 从 /v1/agents 映射 merchant 记录", async () => {
    const { KiwiCatalogMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    const stubFetch = (async (_url: string, _init?: unknown): Promise<Response> => {
      const url = _url;
      const body =
        url.includes("/search")
          ? JSON.stringify({
              results: [
                {
                  catalog_agent_id: "cagt-test-001",
                  principal_type: "merchant",
                  merchant_id: "merchant-cat-001",
                  display_name: "西湖数码",
                  canonical_domain: "xihu.example",
                  agent_card_url: "https://xihu.example/.well-known/agent-card.json",
                  ucp_profile_url: "https://xihu.example/.well-known/ucp",
                  capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"],
                  hosting_mode: "direct_only",
                  verification_level: "domain_verified",
                  freshness_state: "fresh",
                  administrative_state: "active",
                  created_at: "2026-01-01T00:00:00Z",
                  updated_at: "2026-01-01T00:00:00Z",
                },
              ],
              next_cursor: null,
            })
          : "{}";
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const index = new KiwiCatalogMerchantIndex({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: stubFetch,
    });
    const merchants = await index.search("扩展坞");
    expect(merchants).toHaveLength(1);
    expect(merchants[0]?.merchant_id).toBe("merchant-cat-001");
    expect(merchants[0]?.verified).toBe(true);
    expect(merchants[0]?.ucp_profile_url).toBe("https://xihu.example/.well-known/ucp");
  });
});

describe("UCP/KNP boundary conformance（§6.1）", () => {
  it("只暴露 Kiwi Sourcing Tools（9 个：7 高层 + approve/reject 审批），无 UCP/raw-KNP 工具", () => {
    const { service } = makeHarness(makeInMemoryStore());
    const names = buildKiwiTools(service).map((t) => t.name);
    expect(names.sort()).toEqual([...KIWI_SOURCING_TOOLS].sort());
    for (const name of names) {
      expect(name).toMatch(/^kiwi_/);
    }
    const forbidden = [
      "catalog", "cart", "checkout", "order", // UCP primitives
      "send_offer", "evaluate_condition", "resolve_capabilities", "send_rfq", // raw KNP
    ];
    for (const f of forbidden) expect(names).not.toContain(f);
  });
});

describe("默认 catalog 入口（kiwi-buyer 免配置发现）", () => {
  it("默认经 catalog.kiwi.harrylabsj.com 发现，可覆盖", async () => {
    const { DEFAULT_CATALOG_URL } = await import("../src/mcp/cli.js");
    expect(DEFAULT_CATALOG_URL).toBe("https://catalog.kiwi.harrylabsj.com");
  });
});

describe("kiwi_approve / kiwi_reject（ASK 门宿主审批面）", () => {
  const tools = buildKiwiTools;
  /** 从结构化 approval_required 结果安全提取 approval_id（缺失即抛错，避免 `?.id!`）。 */
  function approvalIdFrom(result: { content?: Array<{ text?: string }> }): string {
    const body = JSON.parse(result.content?.[0]?.text ?? "{}") as {
      approval_required?: { approval_id?: string };
    };
    const id = body.approval_required?.approval_id;
    if (typeof id !== "string" || id === "") throw new Error("approval_required missing approval_id");
    return id;
  }
  async function runAcceptApprovalFlow(store: ReturnType<typeof makeInMemoryStore>) {
    const { service } = makeHarness(store);
    const calls = tools(service);
    const call = (name: string, args: Record<string, unknown>) =>
      calls.find((t) => t.name === name)!.handle(args);
    const created = await service.requestQuotes({
      intent: INTENT,
      idempotency_key: "rfq-approve-flow",
      merchant_ids: ["merchant-001"],
    });
    const taskId = String(created.task.task_id);
    const winner = (created.task.candidates as Array<Record<string, unknown>>).find(
      (c) => c.status === "succeeded",
    )!;
    return { service, call, taskId, winner };
  }

  it("accept_agreement 返回结构化 approval_required，宿主 kiwi_approve 后重试成功", async () => {
    const { call, taskId, winner } = await runAcceptApprovalFlow(makeInMemoryStore());
    const acc1 = await call("kiwi_accept_agreement", {
      task_id: taskId,
      candidate_id: String(winner.candidate_id),
    });
    // 结构化返回，不是 isError；approval_id 是 first-class 值。
    expect(acc1.isError).toBeUndefined();
    const body1 = JSON.parse(acc1.content?.[0]?.text ?? "{}") as {
      approval_required?: { approval_id?: string };
    };
    const approvalId = body1.approval_required?.approval_id;
    expect(typeof approvalId).toBe("string");

    const app = await call("kiwi_approve", { approval_id: approvalId!, note: "用户确认" });
    expect(app.isError).toBeUndefined();
    expect((JSON.parse(app.content?.[0]?.text ?? "{}") as { status?: string }).status).toBe("approved");

    const acc2 = await call("kiwi_accept_agreement", {
      task_id: taskId,
      candidate_id: String(winner.candidate_id),
      approval_id: approvalId!,
    });
    expect(acc2.isError).toBeUndefined();
    const body2 = JSON.parse(acc2.content?.[0]?.text ?? "{}") as { agreement?: { binding_effect?: string } };
    expect(body2.agreement?.binding_effect).toBe("nonbinding");
  });

  it("kiwi_reject 后 accept_agreement 被拒（deny 优先）", async () => {
    const { call, taskId, winner } = await runAcceptApprovalFlow(makeInMemoryStore());
    const acc1 = await call("kiwi_accept_agreement", {
      task_id: taskId,
      candidate_id: String(winner.candidate_id),
    });
    const approvalId = approvalIdFrom(acc1);
    const rej = await call("kiwi_reject", { approval_id: approvalId, reason: "价格不合适" });
    expect(rej.isError).toBeUndefined();
    expect((JSON.parse(rej.content?.[0]?.text ?? "{}") as { status?: string }).status).toBe("denied");

    const acc2 = await call("kiwi_accept_agreement", {
      task_id: taskId,
      candidate_id: String(winner.candidate_id),
      approval_id: approvalId,
    });
    expect(acc2.isError).toBe(true);
    expect(acc2.content?.[0]?.text ?? "").toContain("authorization_denied");
  });

  it("重复批准非 pending 审批被拒", async () => {
    const { call, taskId, winner } = await runAcceptApprovalFlow(makeInMemoryStore());
    const acc1 = await call("kiwi_accept_agreement", {
      task_id: taskId,
      candidate_id: String(winner.candidate_id),
    });
    const approvalId = approvalIdFrom(acc1);
    await call("kiwi_approve", { approval_id: approvalId });
    const again = await call("kiwi_approve", { approval_id: approvalId });
    expect(again.isError).toBe(true);
    expect(again.content?.[0]?.text ?? "").toContain("approval_denied");
  });

  it("handoff 缺审批返回结构化 approval_required，approve 后重试成功（独立 handoff 审批）", async () => {
    const { call, taskId, winner } = await runAcceptApprovalFlow(makeInMemoryStore());
    const acc1 = await call("kiwi_accept_agreement", {
      task_id: taskId,
      candidate_id: String(winner.candidate_id),
    });
    const acceptApprovalId = approvalIdFrom(acc1);
    await call("kiwi_approve", { approval_id: acceptApprovalId });
    const acc2 = await call("kiwi_accept_agreement", {
      task_id: taskId,
      candidate_id: String(winner.candidate_id),
      approval_id: acceptApprovalId,
    });
    const agreementId = (JSON.parse(acc2.content?.[0]?.text ?? "{}") as { agreement?: { agreement_id?: string } })
      .agreement?.agreement_id ?? "";

    // handoff 缺 approval → 结构化 approval_required（handoff 独立审批）。
    const hf1 = await call("kiwi_handoff", {
      agreement_id: agreementId,
      destination_type: "external_checkout_url",
    });
    expect(hf1.isError).toBeUndefined();
    const hf1Body = JSON.parse(hf1.content?.[0]?.text ?? "{}") as { approval_required?: { approval_id?: string } };
    const handoffApprovalId = hf1Body.approval_required?.approval_id;
    expect(typeof handoffApprovalId).toBe("string");

    await call("kiwi_approve", { approval_id: handoffApprovalId! });
    const hf2 = await call("kiwi_handoff", {
      agreement_id: agreementId,
      approval_id: handoffApprovalId!,
      destination_type: "external_checkout_url",
      url: "https://merchant-001.example/checkout/xyz",
    });
    expect(hf2.isError).toBeUndefined();
    const hf2Body = JSON.parse(hf2.content?.[0]?.text ?? "{}") as { handoff_ref?: { handoff_id?: string } };
    expect(hf2Body.handoff_ref?.handoff_id).toBeDefined();
  });
});

describe("MarketplaceMerchantIndex（商品 FTS 路由 + 相关度过滤）", () => {
  it("返回匹配查询的商家及各自 matching_skus（过滤标题不含查询词的噪声）", async () => {
    const { MarketplaceMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    const stubFetch = (async (input: string): Promise<Response> => {
      const url = String(input);
      expect(url).toContain("query=");
      const results = [
        { merchant_id: "merchant-hz-xihu", sku: "HZ-DOCK-6IN1", title: "USB-C 扩展坞 6 合 1 HDMI 标准款", price: 189 },
        { merchant_id: "merchant-hz-xihu", sku: "HZ-CABLE-USBCA", title: "USB-C 转 USB-A 转接头 铝合金", price: 19.9 },
        { merchant_id: "merchant-sh-pudong", sku: "SH-DOCK-6IN1", title: "USB-C 扩展坞 6 合 1 HDMI 标准款", price: 199 },
        { merchant_id: "merchant-sh-pudong", sku: "SH-CLIP-100", title: "长尾夹 19mm 100 只装", price: 12.9 },
      ];
      return new Response(JSON.stringify({ ok: true, results }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const index = new MarketplaceMerchantIndex({ baseUrl: "http://127.0.0.1:8765", fetchImpl: stubFetch });
    const merchants = await index.search("USB-C 扩展坞 6 合 1");
    expect(merchants.map((m) => m.merchant_id).sort()).toEqual([
      "merchant-hz-xihu",
      "merchant-sh-pudong",
    ]);
    // 相关度过滤：matching_skus 只含标题命中"扩展坞"的商品，不含转接头/长尾夹。
    expect(merchants.find((m) => m.merchant_id === "merchant-hz-xihu")?.matching_skus).toEqual([
      "HZ-DOCK-6IN1",
    ]);
    expect(merchants.find((m) => m.merchant_id === "merchant-sh-pudong")?.matching_skus).toEqual([
      "SH-DOCK-6IN1",
    ]);
  });
});

describe("MarketplaceQuoteFetcher（真实 RFQ fan-out）", () => {
  it("创建会话、轮询商家回复、携带真实 reply_text", async () => {
    const { MarketplaceQuoteFetcher } = await import("../src/buyer-core/quote-fetcher.js");
    let readCount = 0;
    const stubFetch = (async (input: string, init?: { method?: string }): Promise<Response> => {
      void input;
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            conversation: { id: "CONV-T1", status: "waiting_merchant" },
            buyer_token: "bt-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      readCount += 1;
      const messages =
        readCount >= 2
          ? [
              { id: 1, sender: "buyer", text: "10 个扩展坞？" },
              { id: 2, sender: "merchant_agent", text: "HZ-DOCK-8IN1 has stock 120 and current price 289.00 CNY" },
            ]
          : [{ id: 1, sender: "buyer", text: "10 个扩展坞？" }];
      return new Response(JSON.stringify({ ok: true, conversation: { status: "waiting_buyer", messages } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const fetcher = new MarketplaceQuoteFetcher({
      baseUrl: "http://127.0.0.1:8765",
      buyerBootstrapToken: "bt-bootstrap",
      pollIntervalMs: 10,
      timeoutMs: 500,
      fetchImpl: stubFetch,
    });
    const results = await fetcher.requestQuotes(
      {
        intent_id: "i1",
        intent_type: "purchase",
        items: [{ query: "USB-C 扩展坞", sku: "HZ-DOCK-8IN1", quantity: { value: 10, unit: "个" } }],
      },
      [{ merchant_id: "merchant-hz-xihu", name: "杭州西湖数码", verified: true, capabilities: [] }],
    );
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r?.status).toBe("succeeded");
    expect(r?.provenance?.negotiation_id).toBe("CONV-T1");
    expect(r?.provenance?.merchant_reply_id).toBe("2");
    expect(r?.provenance?.reply_text).toContain("stock 120");
    expect(r?.provenance?.reply_text).toContain("289.00");
  });

  it("商家超时不回复 → failed(timeout)，不编造报价", async () => {
    const { MarketplaceQuoteFetcher } = await import("../src/buyer-core/quote-fetcher.js");
    const stubFetch = (async (input: string, init?: { method?: string }): Promise<Response> => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, conversation: { id: "CONV-T2" }, buyer_token: "bt-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, conversation: { status: "waiting_merchant", messages: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const fetcher = new MarketplaceQuoteFetcher({
      baseUrl: "http://127.0.0.1:8765",
      buyerBootstrapToken: "bt-bootstrap",
      pollIntervalMs: 5,
      timeoutMs: 60,
      fetchImpl: stubFetch,
    });
    const results = await fetcher.requestQuotes(
      { intent_id: "i2", intent_type: "purchase", items: [{ query: "硒鼓" }] },
      [{ merchant_id: "merchant-sh-pudong", name: "上海浦东办公耗材", verified: true, capabilities: [] }],
    );
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("timeout");
  });
});

describe("MarketplaceNegotiator（真实磋商 claim→counter→回复）", () => {
  it("从候选 provenance 读取会话上下文并完成一轮还价", async () => {
    const { MarketplaceNegotiator } = await import("../src/buyer-core/negotiator.js");
    let decisionSeen: string | null = null;
    const stubFetch = (async (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
      const url = String(input);
      if (url.includes("/claims") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, claim: { claimed: true, status: "processing" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/decisions")) {
        const body = JSON.parse(init?.body ?? "{}");
        decisionSeen = body.decision?.action;
        return new Response(JSON.stringify({ ok: true, policy_result: { result: "accepted" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/conversations/")) {
        return new Response(
          JSON.stringify({
            ok: true,
            conversation: {
              status: "waiting_buyer",
              messages: [
                { id: 1, sender: "buyer", text: "报个价" },
                { id: 2, sender: "merchant_agent", text: "stock 180 and current price 189.00 CNY" },
                { id: 3, sender: "buyer", text: "能到 170 吗？" },
                { id: 4, sender: "merchant_agent", text: "可以按 170 成交。" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const negotiator = new MarketplaceNegotiator({ baseUrl: "http://127.0.0.1:8765", fetchImpl: stubFetch });
    const step = await negotiator.negotiate(
      "task-1",
      { constraints: { target_unit_price: { currency: "CNY", amount_minor: 17000 } } },
      { round: 1, action: "counter_offer", summary: "能到 170 吗？" },
      [
        {
          candidate_id: "cand-1",
          merchant_id: "merchant-hz-xihu",
          status: "succeeded",
          provenance: {
            negotiation_id: "CONV-T3",
            merchant_reply_id: "2",
            buyer_token: "bt-t3",
            reply_text: "stock 180 and current price 189.00 CNY",
            sku: "HZ-DOCK-6IN1",
          },
        },
      ],
    );
    expect(decisionSeen).toBe("counter");
    expect(step.round).toBe(1);
    expect(step.reply).toContain("170");
  });

  it("无会话上下文时如实返回（不编造）", async () => {
    const { MarketplaceNegotiator } = await import("../src/buyer-core/negotiator.js");
    const negotiator = new MarketplaceNegotiator({ baseUrl: "http://127.0.0.1:8765" });
    const step = await negotiator.negotiate("task-1", {}, { round: 1, action: "counter_offer", summary: "还价" }, []);
    expect(step.reply).toBeUndefined();
    expect(step.summary).toContain("无会话上下文");
  });
});

describe("MCP server 协议面（§6.1/§6.10 fail-closed）", () => {
  function makeServer() {
    const store = makeInMemoryStore();
    const service = makeHarness(store).service;
    return new McpServer({
      tools: buildKiwiTools(service),
      serverInfo: { name: "kiwi-buyer-mcp", version: "0.1.0" },
    });
  }

  it("未初始化调用 tools/list 被拒（not_initialized）", async () => {
    const server = makeServer();
    const res = await server.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    );
    expect(res?.error?.code).toBe(-32002);
  });

  it("initialize 版本协商 fail-closed：未知版本被拒", async () => {
    const server = makeServer();
    const res = await server.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2099-99-99", clientInfo: { name: "test" } },
      }),
    );
    expect(res?.error?.code).toBe(-32602);
    expect(res?.error?.message).toContain("unsupported");
  });

  it("initialize + initialized 后 tools/list 返回 7 个工具", async () => {
    const server = makeServer();
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSIONS[0], clientInfo: { name: "test" } },
      }),
    );
    await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const res = await server.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    );
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...KIWI_SOURCING_TOOLS].sort());
  });

  it("tools/call 完整流程经 JSON-RPC 可用", async () => {
    const server = makeServer();
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSIONS[0], clientInfo: { name: "test" } },
      }),
    );
    await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const res = await server.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "kiwi_request_quotes",
          arguments: {
            intent: INTENT,
            idempotency_key: "rfq-mcp-1",
            merchant_ids: ["merchant-001", "merchant-002"],
          },
        },
      }),
    );
    const toolResult = res?.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(toolResult.isError).not.toBe(true);
    const parsed = JSON.parse(toolResult.content[0]?.text ?? "{}") as { task_id: string; created: boolean };
    expect(parsed.created).toBe(true);
    expect(parsed.task_id).toMatch(/^task-/);
  });

  it("未知工具返回 tool_not_found", async () => {
    const server = makeServer();
    await server.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSIONS[0] },
      }),
    );
    await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const res = await server.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "kiwi_nope", arguments: {} } }),
    );
    expect(res?.error?.code).toBe(-32002);
  });

  it("非法 JSON 返回 parse error", async () => {
    const server = makeServer();
    const res = await server.handleMessage("{not json");
    expect(res?.error?.code).toBe(-32700);
  });

  it("未知方法返回 method_not_found", async () => {
    const server = makeServer();
    const res = await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "resources/list" }));
    expect(res?.error?.code).toBe(-32601);
  });
});

describe("持久化：重启后 pending/approval 可解释（§6.2）", () => {
  it("任务与审批在 store 重开后仍可解析", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-mcp-"));
    const dbPath = path.join(dir, "state.sqlite");
    const store1 = new TaskApprovalStore({ dbPath });
    const { service } = makeHarness(store1);
    const created = await service.requestQuotes({ intent: INTENT, idempotency_key: "rfq-restart" });
    const taskId = String(created.task.task_id);
    const approval = service.requestApproval({ task_id: taskId, action: "handoff" });
    store1.close();

    // 重启：同一 db 文件重新打开
    const store2 = new TaskApprovalStore({ dbPath });
    const service2 = new KiwiBuyerService({
      store: store2,
      principal: "company:acme-test",
      buyerAgentId: "buyer-agent:test",
      sessionId: "session-test-1",
      delegationPolicy: POLICY,
      merchantIndex: MERCHANTS,
    });
    const fetched = service2.getTask(taskId);
    expect(fetched.task.task_id).toBe(taskId);
    expect(fetched.task.idempotency_key).toBe("rfq-restart");
    const pending = store2.getApproval(approval.approval_id);
    expect(pending?.status).toBe("pending");
    expect(pending?.task_id).toBe(taskId);
    // pending 审批在重启后仍可解释：再次请求 handoff 得到 approval_required，而非幽灵。
    await expect(
      service2.evaluateAuthorization("handoff", { taskId, approvalId: approval.approval_id }),
    ).rejects.toMatchObject({ code: "approval_required" });
    store2.close();
  });
});
