/**
 * BUG-07 回归测试：策略变更必须真正应用到运行时。
 *
 * 覆盖：
 *  - MerchantPolicyRuntime：patch 校验（与 profile 同规则，未知/非法字段拒绝、
 *    不落盘不生效）、原子写**完整生效策略**（version/updated_at/policy）、
 *    版本单调/digest 变化、null 删键、重启后版本与策略延续；
 *  - 跨进程生效：写端实例 apply 后，读端实例（模拟 A2A 子进程）按文件
 *    mtime 在下一次报价前读到新策略；坏文件保留上一个良好策略并告警；
 *    legacy patch 格式（修复前的文件）忽略并回退 base；
 *  - A2A 报价端到端：handler 以 provider 接运行中策略——提高底价后，下一次
 *    counter_offer 的确定性基线立即采用新底价（"改了就生效"）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MerchantPolicyRuntime } from "../src/merchant-core/policy-runtime.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import type { NegotiationHandler, NegotiationHandlerResult } from "../src/a2a/server/types.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";

const NOW = "2026-09-15T10:00:00.000Z";
const CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

function newFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-policy-rt-"));
  dirs.push(dir);
  return path.join(dir, "policy-overrides.json");
}

describe("MerchantPolicyRuntime（BUG-07 写端）", () => {
  it("apply：未知字段拒绝——不落盘、不生效、版本不前进", () => {
    const file = newFile();
    const rt = new MerchantPolicyRuntime({ basePolicy: undefined, file, now: () => NOW });
    expect(() => rt.apply({ unknown_key: 1 })).toThrow();
    expect(rt.current().version).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it("apply：非法值拒绝（复用 profile 同一套校验）", () => {
    const file = newFile();
    const rt = new MerchantPolicyRuntime({ basePolicy: undefined, file, now: () => NOW });
    expect(() => rt.apply({ max_auto_discount_percent: 150 })).toThrow();
    expect(() => rt.apply({ price_floors: { "SKU-001": -5 } })).toThrow();
    expect(rt.current().version).toBe(0);
  });

  it("apply：原子写**完整生效策略**（非裸 patch），版本单调、digest 变化", () => {
    const file = newFile();
    const rt = new MerchantPolicyRuntime({ basePolicy: undefined, file, now: () => NOW });
    const first = rt.apply({ max_auto_discount_percent: 10 });
    expect(first).toMatchObject({ version: 1, applied_keys: ["max_auto_discount_percent"] });
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      updated_at: string;
      policy: unknown;
    };
    expect(saved).toMatchObject({ version: 1, updated_at: NOW, policy: { max_auto_discount_percent: 10 } });
    const before = rt.current().digest;
    const second = rt.apply({ delivery_lead_days: 3 });
    expect(second.version).toBe(2);
    // 合并语义：新 patch 不清掉旧键（完整生效策略 = base 之上的累积）。
    expect(rt.current().policy).toEqual({ max_auto_discount_percent: 10, delivery_lead_days: 3 });
    expect(rt.current().digest).not.toBe(before);
  });

  it("apply：值为 null 的键表示删除；空 patch 拒绝", () => {
    const file = newFile();
    const rt = new MerchantPolicyRuntime({
      basePolicy: { min_unit_price_private: 60 },
      file,
      now: () => NOW,
    });
    rt.apply({ min_unit_price_private: null });
    expect(rt.current().policy).toEqual({});
    expect(() => rt.apply({})).toThrow();
  });

  it("重启延续：新实例从文件恢复策略与版本", () => {
    const file = newFile();
    const writer = new MerchantPolicyRuntime({ basePolicy: undefined, file, now: () => NOW });
    writer.apply({ delivery_lead_days: 5 });
    writer.apply({ delivery_lead_days: 7 });
    const restarted = new MerchantPolicyRuntime({
      basePolicy: { delivery_lead_days: 1 },
      file,
      now: () => NOW,
    });
    // 覆盖层一旦存在即完全接管（文件 = 完整生效策略，遮蔽 base）。
    expect(restarted.current()).toMatchObject({ version: 2, policy: { delivery_lead_days: 7 } });
  });

  it("跨进程生效：读端实例按文件 mtime 读到写端的新策略（digest 一致）", () => {
    const file = newFile();
    const reader = new MerchantPolicyRuntime({ basePolicy: undefined, file, now: () => NOW });
    const writer = new MerchantPolicyRuntime({ basePolicy: undefined, file, now: () => NOW });
    expect(reader.current().policy).toBeUndefined();
    writer.apply({ min_unit_price_private: 80 });
    const after = reader.current();
    expect(after.policy).toEqual({ min_unit_price_private: 80 });
    expect(after.digest).toBe(writer.current().digest);
    expect(after.version).toBe(1);
  });

  it("坏文件：读端保留上一个良好策略，同一坏文件只告警一次", () => {
    const file = newFile();
    const logs: string[] = [];
    const reader = new MerchantPolicyRuntime({
      basePolicy: { delivery_lead_days: 2 },
      file,
      now: () => NOW,
      log: (m) => logs.push(m),
    });
    writeFileSync(file, "{ not json");
    expect(reader.current().policy).toEqual({ delivery_lead_days: 2 });
    expect(reader.current().version).toBe(0);
    reader.current();
    reader.current();
    expect(logs).toHaveLength(1);
  });

  it("legacy patch 格式（修复前产物）：忽略并回退 base，不误生效", () => {
    const file = newFile();
    const logs: string[] = [];
    const rt = new MerchantPolicyRuntime({
      basePolicy: { delivery_lead_days: 2 },
      file,
      now: () => NOW,
      log: (m) => logs.push(m),
    });
    writeFileSync(file, `${JSON.stringify({ updated_at: NOW, patch: { delivery_lead_days: 99 } })}\n`);
    expect(rt.current().policy).toEqual({ delivery_lead_days: 2 });
    expect(logs).toHaveLength(1);
  });
});

// ---- A2A 报价端到端：策略变更后下一次报价立即采用新值 ----------------------

const NEG_A = "neg_policy_a";
const NEG_B = "neg_policy_b";
let seq = 0;

function envelopeFor(action: string, payload: Record<string, unknown>, negotiationId: string): NegotiationEnvelope {
  seq += 1;
  return finalizeEnvelope({
    capability: CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: negotiationId,
    exchange_id: `ex_policy_${seq}`,
    message_id: `msg_policy_${seq}`,
    in_reply_to: `msg_policy_${seq - 1}`,
    actor: "buyer",
    action: action as NegotiationEnvelope["action"],
    created_at: NOW,
    payload: payload as never,
  });
}

async function run(handler: NegotiationHandler, envelope: NegotiationEnvelope): Promise<NegotiationHandlerResult> {
  return handler.handle({
    envelope: envelope as never,
    message: { role: "user", parts: [], messageId: envelope.message_id },
    taskId: `task_policy_${seq}`,
    senderIdentity: "buyer:buyer-001",
  });
}

/** counter_offer 回执中确定性基线（base_terms 首条目 unit_price）。 */
function conditionalBaseMinor(result: NegotiationHandlerResult): number {
  const reply =
    result.kind === "accepted" && result.message
      ? (result.message.parts[0] as unknown as {
          data?: { knp_envelope?: { payload?: Record<string, unknown> } };
        }).data?.knp_envelope?.payload
      : undefined;
  expect(reply).toBeTruthy();
  return (
    (reply as {
      base_terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> };
    })?.base_terms?.items?.[0]?.unit_price?.amount_minor as number
  );
}

describe("A2A 报价使用运行中策略（BUG-07 端到端）", () => {
  it("改变公开折扣策略后，下一次 counter_offer 的确定性基线立即采用新边界", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-policy-e2e-"));
    dirs.push(dir);
    const file = path.join(dir, "policy-overrides.json");
    // 读端（A2A 进程口径）：provider 每请求取运行中策略。
    const policyRuntime = new MerchantPolicyRuntime({
      basePolicy: { price_floors: { "SKU-001": 60 }, max_auto_discount_percent: 5 },
      file,
      now: () => NOW,
    });
    const ledgerDir = path.join(dir, "ledger");
    const handler = createMerchantHandler({
      ledger: new LedgerStore({ dir: ledgerDir, now: () => NOW }),
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
      productSource: {
        getProduct: async () => ({ price: 850, currency: "CNY", stock: 200 }),
      },
      merchantPolicy: () => policyRuntime.current().policy,
    });
    const counter = (negotiationId: string) =>
      envelopeFor(
        "counter_offer",
        {
          offer_id: "off_b",
          proposed_terms: {
            items: [
              { sku: "SKU-001", quantity: { value: 1 }, unit_price: { amount_minor: 7000 } },
            ],
          },
        },
        negotiationId,
      );
    const rfq = (negotiationId: string) =>
      envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 1 } }] }, negotiationId);
    // 变更前：list 85000 minor，公开折扣 5% → 公开边界 80750；还价 7000 低于边界 → 压回 80750。
    // （注意：这里观察的是**公开策略**而不是私有底价——底价不再直接决定回价，
    //  这正是 T045「不泄露底价」修复后的语义。）
    await run(handler, rfq(NEG_A));
    expect(conditionalBaseMinor(await run(handler, counter(NEG_A)))).toBe(80750);
    // 商家把公开折扣放宽到 20%（经写端 apply；等价于 MCP 进程写入文件）。
    policyRuntime.apply({ max_auto_discount_percent: 20 });
    // 变更后：**下一次报价**即采用新边界 68000（还价 7000 仍低于边界 → 压回 68000）。
    await run(handler, rfq(NEG_B));
    expect(conditionalBaseMinor(await run(handler, counter(NEG_B)))).toBe(68000);
  });
});
