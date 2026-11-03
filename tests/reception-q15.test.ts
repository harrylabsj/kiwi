/**
 * Q15 场景运行器（D13 / AC39 的 P0a 切片）。
 *
 * 用脚本化 interpreter 驱动真实接待引擎，逐回合执行预标注脚本并检查：
 *  - 字段检查点：回复文本必含/禁含（价格、交期等从夹具推导，不硬编码）；
 *  - 结构检查点：ResponsePlan 块序列、澄清原因、审批计数、会话 revision、reply_seq；
 *  - 全局硬门（每回合、每场景都过）：locale=zh-CN、回复非空、不含私有底价、
 *    不含公开折扣边界数值、不含“底价/成本”字样、reply_seq 严格递增、
 *    outbox 每回合一条 dispatched 记录、追问回合数不超上限。
 *
 * 注意：脚本化 interpreter 只验证系统侧行为；模型理解质量（真实 provider、
 * 每例 3 次重复、分层门槛）属 M6 待执行证据，本运行器不冒充该结论。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import type { InquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import {
  Q15_NOW,
  RECEPTION_Q15_SCENARIOS,
  type QScenario,
} from "./reception-q15.scenarios.js";

const MERCHANT = "merchant-q15";
const IDENTITY = "buyer-q15";
const CONTEXT = "ctx_q15";

/** 从夹具推导占位符（预期值来自夹具，不从被测输出回读）。 */
function placeholders(scenario: QScenario): Record<string, string> {
  const sku = Object.keys(scenario.products)[0]!;
  const product = scenario.products[sku]!;
  const policy = scenario.policy ?? {};
  const values: Record<string, string> = {
    "{sku}": sku,
    "{price}": product.price.toFixed(2),
  };
  const floor = policy.price_floors?.[sku];
  if (floor !== undefined) values["{floor}"] = floor.toFixed(2);
  const pct = policy.max_auto_discount_percent;
  if (pct !== undefined && pct > 0) {
    values["{bound}"] = ((product.price * (100 - pct)) / 100).toFixed(2);
  }
  if (policy.delivery_lead_days !== undefined) {
    const delivery = new Date(
      Date.parse(Q15_NOW) + policy.delivery_lead_days * 86_400_000,
    ).toISOString();
    values["{delivery}"] = delivery.slice(0, 10);
  }
  return values;
}

function resolve(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(key).join(value);
  }
  return out;
}

describe("Q15 数据集完整性", () => {
  it("15 例、id 唯一且为 Q01–Q15", () => {
    expect(RECEPTION_Q15_SCENARIOS).toHaveLength(15);
    const ids = RECEPTION_Q15_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(15);
    expect([...ids].sort()).toEqual(
      Array.from({ length: 15 }, (_, i) => `Q${String(i + 1).padStart(2, "0")}`),
    );
  });

  it("六层主类别互斥且安全两层（故障/待批、注入/越界）均有覆盖", () => {
    const layers = new Set(RECEPTION_Q15_SCENARIOS.map((s) => s.layer));
    expect(layers).toEqual(
      new Set(["理解/解释", "澄清", "多轮/时间", "受控协商", "故障/待批", "注入/越界"]),
    );
  });

  it("每例预标注目标、关联 AC、追问上限与至少一次输入", () => {
    for (const s of RECEPTION_Q15_SCENARIOS) {
      expect(s.goal.length).toBeGreaterThan(0);
      expect(s.ac.length).toBeGreaterThan(0);
      for (const ac of s.ac) expect(ac).toMatch(/^AC\d{2}$/);
      expect(s.maxClarifications).toBeGreaterThanOrEqual(0);
      expect(s.turns.length).toBeGreaterThanOrEqual(1);
      for (const turn of s.turns) expect(turn.expect.blockKinds.length).toBeGreaterThan(0);
    }
  });
});

describe("Q15 场景执行（脚本化候选 + 真实引擎）", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  for (const scenario of RECEPTION_Q15_SCENARIOS) {
    it(`${scenario.id} [${scenario.layer}] ${scenario.title}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "kiwi-q15-"));
      dirs.push(dir);
      let currentNow = Q15_NOW;
      const store = new ReceptionConversationStore({
        file: join(dir, "conversations.json"),
        now: () => currentNow,
      });
      const outbox = new ReceptionReplyOutbox({
        file: join(dir, "reply-outbox.json"),
        now: () => currentNow,
      });
      const approvals = new NegotiationApprovalStore(dir, () => currentNow);

      // 脚本化 interpreter：按回合取预标注候选；"throw" 模拟供应商故障。
      let activeTurn = 0;
      const interpreter: InquiryInterpreter = {
        async interpret() {
          const turn = scenario.turns[activeTurn];
          if (turn?.advanceClockDuringInterpretMs !== undefined) {
            currentNow = new Date(
              Date.parse(currentNow) + turn.advanceClockDuringInterpretMs,
            ).toISOString();
          }
          const value = turn?.interpretation;
          if (value === "throw") throw new Error("provider unavailable");
          return value === undefined || value === "none" ? undefined : value;
        },
      };

      const engine = createMerchantReceptionEngine({
        store,
        outbox,
        interpreter,
        productSource: {
          async getProduct(sku: string) {
            const product = scenario.products[sku];
            if (product === undefined) throw new Error(`unknown sku ${sku}`);
            return product;
          },
        },
        policy: () => scenario.policy as never,
        approvals,
        now: () => currentNow,
      });

      const values = placeholders(scenario);
      const floorText = values["{floor}"];
      const boundText = values["{bound}"];
      let lastSeq = 0;
      let clarificationTurns = 0;

      for (const [index, turn] of scenario.turns.entries()) {
        activeTurn = index;
        if (turn.setNow !== undefined) currentNow = turn.setNow;
        const result = await engine.respond({
          merchantId: MERCHANT,
          identity: IDENTITY,
          identityVerified: false,
          contextId: CONTEXT,
          text: turn.text,
          now: currentNow,
          ...(turn.structured !== undefined ? { structured: turn.structured } : {}),
        });

        // 全局硬门（每回合）。
        expect(result.plan.locale).toBe("zh-CN");
        expect(result.text.length).toBeGreaterThan(0);
        expect(result.text).not.toContain("底价");
        expect(result.text).not.toContain("成本");
        if (floorText !== undefined) expect(result.text).not.toContain(floorText);
        if (boundText !== undefined) expect(result.text).not.toContain(boundText);
        expect(result.reply.reply_seq).toBe(lastSeq + 1);
        lastSeq = result.reply.reply_seq;

        // §16.1：每回合恰好一条 dispatched 出站记录。
        const outboxRecords = outbox.list(MERCHANT, IDENTITY, CONTEXT);
        expect(outboxRecords).toHaveLength(index + 1);
        expect(outboxRecords.every((r) => r.status === "dispatched")).toBe(true);

        // 结构检查点。
        expect(result.plan.blocks.map((b) => b.kind)).toEqual(turn.expect.blockKinds);
        if (turn.expect.clarificationReason !== undefined) {
          clarificationTurns += 1;
          const block = result.plan.blocks.find((b) => b.kind === "ask_clarification");
          expect(
            block !== undefined && block.kind === "ask_clarification" ? block.reason : undefined,
          ).toBe(turn.expect.clarificationReason);
        }

        // 字段检查点。
        for (const text of turn.expect.contains ?? []) {
          expect(result.text).toContain(resolve(text, values));
        }
        for (const text of turn.expect.notContains ?? []) {
          expect(result.text).not.toContain(resolve(text, values));
        }

        // 审批存证。
        if (turn.expect.approvals?.pending !== undefined) {
          expect(approvals.list("pending")).toHaveLength(turn.expect.approvals.pending);
        }
        if (turn.expect.approvals?.expired !== undefined) {
          const expired = approvals.list("expired");
          expect(expired).toHaveLength(turn.expect.approvals.expired);
          // 到期只失效：expired 候选不可再批准。sweepExpired 已固化状态时
          // 报"no pending match"，未固化时报"expired"，两者都是合法拒绝。
          for (const record of expired) {
            expect(() =>
              approvals.approve({
                approval_id: record.approval_id,
                approved_minor: record.buyer_offer_minor,
              }),
            ).toThrow(/expired|no pending/);
          }
        }
        if (turn.expect.buyerOfferMinor !== undefined) {
          const pending = approvals.list("pending");
          expect(pending.at(-1)?.buyer_offer_minor).toBe(turn.expect.buyerOfferMinor);
        }

        // 会话状态。
        if (turn.expect.conversation?.sku !== undefined) {
          expect(result.conversation.need.sku).toBe(turn.expect.conversation.sku);
        }
        if (turn.expect.conversation?.quantity !== undefined) {
          expect(result.conversation.need.quantity).toBe(turn.expect.conversation.quantity);
        }
        if (turn.expect.conversation?.revision !== undefined) {
          expect(result.conversation.need.revision).toBe(turn.expect.conversation.revision);
        }
        if (turn.expect.replySeq !== undefined) {
          expect(result.reply.reply_seq).toBe(turn.expect.replySeq);
        }
      }

      // 追问上限。
      expect(clarificationTurns).toBeLessThanOrEqual(scenario.maxClarifications);
    });
  }
});
