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
 * A 卡（KIWI-IMPLEMENT-APPROVED-AB-20261019）正负控：handoff 意图绑定。
 *
 * 经**真实 MCP 工具入口**（`buildKiwiTools(...).handle`）与 `KiwiBuyerService` 执行，
 * 覆盖：ASK 分支在泛型审批之前只写一条 intent 绑定审批；换目的地拒绝且不消耗；
 * 同 approval+intent 重放返回原 ref；缺 intent 的旧 handoff 审批拒绝；terms 现值语义；
 * policy 快照不可被调用方事后改写；非法目的地拒绝；其他 action 不受影响。
 *
 * 只使用内存 DB 与合成数据，不触碰真实 profile/账本/网络。
 */
import { afterEach, describe, expect, it } from "vitest";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { KiwiBuyerService } from "../src/buyer-core/service.js";
import { buildKiwiTools } from "../src/mcp/tools.js";
import { contentDigest } from "../src/negotiation/jcs.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const DEST_A = { destination_type: "external_checkout_url", url: "https://shop.example.com/checkout?a=1" };
const DEST_B = { destination_type: "external_checkout_url", url: "https://evil.example.com/checkout?a=1" };

interface Fixture {
  service: KiwiBuyerService;
  store: TaskApprovalStore;
  call: (name: string, args: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }>;
  agreementId: string;
  taskId: string;
  candidateId: string;
  policy: Record<string, unknown>;
}

async function fixture(overrides: { handoffMode?: "ask" | "auto" | "never"; clock?: { ms: number } } = {}): Promise<Fixture> {
  const store = new TaskApprovalStore({ dbPath: ":memory:" });
  const policy: Record<string, unknown> = {
    policy_id: "p-a-card",
    expires_at: "2099-12-31T23:59:59Z",
    actions: {
      discover: { mode: "auto" },
      inquiry_rfq: { mode: "auto" },
      compare_offers: { mode: "auto" },
      counter_offer: { mode: "auto" },
      accept_nonbinding: { mode: "ask" },
      handoff: { mode: overrides.handoffMode ?? "ask" },
      payment: { mode: "never" },
    },
    limits: {},
  };
  const service = new KiwiBuyerService({
    store,
    principal: "company:a-card",
    buyerAgentId: "buyer:a-card",
    sessionId: "session:a-card",
    ...(overrides.clock ? { now: () => new Date(overrides.clock!.ms).toISOString() } : {}),
    delegationPolicy: policy as never,
    merchantIndex: {
      search: async () => [{ merchant_id: "merchant-a", name: "local", verified: true, capabilities: [] }],
      resolveById: async () => ({ merchant_id: "merchant-a", name: "local", verified: true, capabilities: [] }),
    },
    quoteFetcher: {
      requestQuotes: async () => [
        {
          merchant_id: "merchant-a",
          status: "succeeded",
          terms: {
            currency: "CNY",
            items: [{ sku: "s", quantity_value: 1, quantity_unit: "piece", unit_price_minor: 100 }],
            total_price_minor: 100,
          },
          provenance: { offer_id: "o", negotiation_id: "n", source: "synthetic-local" },
        },
      ],
    },
  });
  cleanup.push(() => store.close());

  const created = await service.requestQuotes({
    intent: { intent_id: "i", intent_type: "purchase", items: [{ query: "synthetic", sku: "s", quantity: { value: 1, unit: "piece" } }] },
    idempotency_key: "i",
    merchant_ids: ["merchant-a"],
  });
  const taskId = String(created.task.task_id);
  const candidate = store.listCandidates(taskId)[0]!;
  const candidateId = String(candidate.candidate_id);

  const { approval_id } = service.requestApproval({
    task_id: taskId,
    action: "accept_nonbinding",
    candidate_digest: contentDigest(candidate),
  });
  service.approve({ approval_id });
  const accepted = await service.acceptAgreement({ task_id: taskId, candidate_id: candidateId, approval_id });
  const agreementId = String(accepted.agreement.agreement_id);

  const tools = buildKiwiTools(service);
  const call = (name: string, args: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.handle(args) as Promise<{ content?: Array<{ text?: string }>; isError?: boolean }>;

  return { service, store, call, agreementId, taskId, candidateId, policy };
}

const body = (r: { content?: Array<{ text?: string }> }) => JSON.parse(r.content?.[0]?.text ?? "{}");

describe("A 卡：handoff 意图绑定", () => {
  it("ASK 分支只写一条带 intent 的审批，不产生无目的地审批", async () => {
    const x = await fixture();
    const res = await x.call("kiwi_handoff", { agreement_id: x.agreementId, ...DEST_A });
    const payload = body(res);
    expect(payload.approval_required?.approval_id).toBeTypeOf("string");

    const approvals = x.store.listApprovalsByTask(x.taskId).filter((a) => a.action === "handoff");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.intent_digest).toBeTypeOf("string");
    const intent = x.store.getHandoffIntent(approvals[0]!.intent_digest!);
    expect(intent).toBeDefined();
    expect(intent!.destination_type).toBe(DEST_A.destination_type);
    expect(intent!.url).toBe(DEST_A.url);
    expect(intent!.agreement_id).toBe(x.agreementId);
  });

  it("换目的地：拒绝且不消耗原审批", async () => {
    const x = await fixture();
    const ask = body(await x.call("kiwi_handoff", { agreement_id: x.agreementId, ...DEST_A }));
    const approvalId = ask.approval_required.approval_id as string;
    x.service.approve({ approval_id: approvalId });

    const changed = await x.call("kiwi_handoff", { agreement_id: x.agreementId, approval_id: approvalId, ...DEST_B });
    expect(changed.isError).toBe(true);
    expect(changed.content?.[0]?.text ?? "").toContain("approval_denied");
    const after = x.store.getApproval(approvalId)!;
    expect(after.status).toBe("approved");

    const ok = body(await x.call("kiwi_handoff", { agreement_id: x.agreementId, approval_id: approvalId, ...DEST_A }));
    expect(ok.handoff_ref.handoff_id).toBeTypeOf("string");
    expect(x.store.getApproval(approvalId)!.status).toBe("used");
  });

  it("同 approval+intent 重放返回原 handoff_ref", async () => {
    const x = await fixture();
    const ask = body(await x.call("kiwi_handoff", { agreement_id: x.agreementId, ...DEST_A }));
    const approvalId = ask.approval_required.approval_id as string;
    x.service.approve({ approval_id: approvalId });
    const first = body(await x.call("kiwi_handoff", { agreement_id: x.agreementId, approval_id: approvalId, ...DEST_A }));
    const replay = body(await x.call("kiwi_handoff", { agreement_id: x.agreementId, approval_id: approvalId, ...DEST_A }));
    expect(replay.handoff_ref.handoff_id).toBe(first.handoff_ref.handoff_id);
  });

  it("缺 intent 的旧 handoff 审批被拒绝（其他 action 不受影响）", async () => {
    const x = await fixture();
    const ask = body(await x.call("kiwi_handoff", { agreement_id: x.agreementId, ...DEST_A }));
    const approvalId = ask.approval_required.approval_id as string;
    x.service.approve({ approval_id: approvalId });
    // 模拟升级前的旧行：清掉 intent 绑定
    x.store.bindApprovalIntent(approvalId, "");
    const db = (x.store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
    db.prepare("UPDATE mcp_approvals SET intent_digest = NULL WHERE approval_id = ?").run(approvalId);

    const res = await x.call("kiwi_handoff", { agreement_id: x.agreementId, approval_id: approvalId, ...DEST_A });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? "").toContain("缺少 handoff 意图");

    // accept_nonbinding 路径不受影响：新任务仍可正常 accept
    const again = await fixture();
    const acc = again.store.listApprovalsByTask(again.taskId).find((a) => a.action === "accept_nonbinding")!;
    expect(acc.intent_digest).toBeUndefined();
  });

  it("terms 现值语义：缺失写 null，存在写现值", async () => {
    const x = await fixture();
    const ask = body(await x.call("kiwi_handoff", { agreement_id: x.agreementId, ...DEST_A }));
    const approvalId = ask.approval_required.approval_id as string;
    const intent = x.store.getHandoffIntent(x.store.getApproval(approvalId)!.intent_digest!)!;
    const agreement = x.store.getAgreement(x.agreementId)!;
    expect(intent.terms_digest).toBe(agreement.terms_digest ?? null);
    expect(intent.agreement_sha256).toBeTypeOf("string");
  });

  it("policy 快照不可被调用方事后改写（既有实例授权不变）", async () => {
    const x = await fixture();
    // 调用方把原对象改成 never：已构造实例仍按 ask 走
    (x.policy.actions as Record<string, { mode: string }>).handoff = { mode: "never" };
    const res = await x.call("kiwi_handoff", { agreement_id: x.agreementId, ...DEST_A });
    const payload = body(res);
    expect(payload.approval_required?.approval_id).toBeTypeOf("string");
  });

  it("非法目的地：未知类型 / 会话类带 url / 带 fragment / 内嵌凭据 全部拒绝", async () => {
    const x = await fixture();
    const cases = [
      { agreement_id: x.agreementId, destination_type: "not_a_type", url: "https://a.example.com/x" },
      { agreement_id: x.agreementId, destination_type: "merchant_checkout_session", url: "https://a.example.com/x" },
      { agreement_id: x.agreementId, destination_type: "external_checkout_url", url: "https://a.example.com/x#frag" },
      { agreement_id: x.agreementId, destination_type: "external_checkout_url", url: "https://u:p@a.example.com/x" },
      { agreement_id: x.agreementId, destination_type: "external_checkout_url" },
    ];
    for (const args of cases) {
      const res = await x.call("kiwi_handoff", args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    // 非法请求不得留下任何 handoff 审批
    expect(x.store.listApprovalsByTask(x.taskId).filter((a) => a.action === "handoff")).toHaveLength(0);
  });

  it("policy 自身过期必须拒绝（即使 DB 内其它期限被人为延长）", async () => {
    const clock = { ms: Date.parse("2026-10-19T00:00:00Z") };
    const x = await fixture({ clock });
    const ask = body(await x.call("kiwi_handoff", { agreement_id: x.agreementId, ...DEST_A }));
    const approvalId = ask.approval_required.approval_id as string;
    x.service.approve({ approval_id: approvalId });
    const intentDigest = x.store.getApproval(approvalId)!.intent_digest!;

    // 人为把 DB 内 task/approval/intent 期限延到 2101（policy 仍 2099 到期）。
    const db = (x.store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
    const far = "2101-01-01T00:00:00.000Z";
    db.prepare("UPDATE mcp_tasks SET expires_at = ? WHERE task_id = ?").run(far, x.taskId);
    db.prepare("UPDATE mcp_approvals SET expires_at = ? WHERE approval_id = ?").run(far, approvalId);
    db.prepare("UPDATE mcp_handoff_intents SET expires_at = ? WHERE intent_digest = ?").run(far, intentDigest);

    clock.ms = Date.parse("2100-06-01T00:00:00Z");
    const res = await x.call("kiwi_handoff", { agreement_id: x.agreementId, approval_id: approvalId, ...DEST_A });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? "").toContain("委托策略已过期");
    expect(x.store.getApproval(approvalId)!.status).toBe("approved");
  });

  it("intent 内容被改（摘要不复算就会漏检）：issued_at 篡改必须拒绝且不消耗", async () => {
    const x = await fixture();
    const ask = body(await x.call("kiwi_handoff", { agreement_id: x.agreementId, ...DEST_A }));
    const approvalId = ask.approval_required.approval_id as string;
    x.service.approve({ approval_id: approvalId });
    const intentDigest = x.store.getApproval(approvalId)!.intent_digest!;

    const db = (x.store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
    db.prepare("UPDATE mcp_handoff_intents SET issued_at = ? WHERE intent_digest = ?").run("2000-01-01T00:00:00.000Z", intentDigest);

    const res = await x.call("kiwi_handoff", { agreement_id: x.agreementId, approval_id: approvalId, ...DEST_A });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? "").toContain("意图摘要与存储不一致");
    expect(x.store.getApproval(approvalId)!.status).toBe("approved");
  });

  it("intent 版本被改：拒绝（版本与摘要双重校验）", async () => {
    const x = await fixture();
    const ask = body(await x.call("kiwi_handoff", { agreement_id: x.agreementId, ...DEST_A }));
    const approvalId = ask.approval_required.approval_id as string;
    x.service.approve({ approval_id: approvalId });
    const intentDigest = x.store.getApproval(approvalId)!.intent_digest!;
    const db = (x.store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
    db.prepare("UPDATE mcp_handoff_intents SET intent_version = ? WHERE intent_digest = ?").run("0", intentDigest);
    const res = await x.call("kiwi_handoff", { agreement_id: x.agreementId, approval_id: approvalId, ...DEST_A });
    expect(res.isError).toBe(true);
  });

  it("accept_nonbinding 行为不变（approval 无 intent 也能正常消费）", async () => {
    const x = await fixture();
    const candidate = x.store.listCandidates(x.taskId)[0]!;
    const { approval_id } = x.service.requestApproval({
      task_id: x.taskId,
      action: "accept_nonbinding",
      candidate_digest: contentDigest(candidate),
    });
    x.service.approve({ approval_id });
    const accepted = await x.service.acceptAgreement({
      task_id: x.taskId,
      candidate_id: String(candidate.candidate_id),
      approval_id,
    });
    expect(accepted.agreement.agreement_id).toBeTypeOf("string");
  });
});
