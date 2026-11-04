/**
 * request_human_help 只能在实际创建并验证 pending 审批后发布。
 * 目标价未越界、缺少数量、审批存储失败都必须走真实兜底，不得声称待确认。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import {
  createMerchantReceptionEngine,
  type ReceptionApprovalSink,
} from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import type { InquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import type { ReceptionAgentRuntime } from "../src/a2a/reception/agent-runtime.js";

const NOW = "2026-11-03T04:00:00.000Z";
const SKU = "VQ-001";
const policy = {
  price_floors: { [SKU]: 100 },
  max_auto_discount_percent: 5,
  delivery_lead_days: 7,
};

describe("reception approval claims are server-verified", () => {
  let dir: string;
  let store: ReceptionConversationStore;
  let outbox: ReceptionReplyOutbox;
  let approvals: NegotiationApprovalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-reception-approval-claim-"));
    store = new ReceptionConversationStore({ file: join(dir, "conversations.json"), now: () => NOW });
    outbox = new ReceptionReplyOutbox({ file: join(dir, "outbox.json"), now: () => NOW });
    approvals = new NegotiationApprovalStore(dir, () => NOW);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const productSource = {
    async getProduct() {
      return { price: 110, currency: "CNY", stock: 50, unit: "piece" };
    },
  };
  const input = (text = "两件") => ({
    merchantId: "merchant-1",
    identity: "buyer:1",
    identityVerified: false,
    contextId: "ctx-1",
    text,
    now: NOW,
  });
  function engineFor(
    interpreter: InquiryInterpreter | undefined,
    approvalSink: ReceptionApprovalSink = approvals,
    agent?: ReceptionAgentRuntime,
  ) {
    return createMerchantReceptionEngine({
      store,
      outbox,
      ...(interpreter !== undefined ? { interpreter } : {}),
      productSource,
      policy: () => policy as never,
      approvals: approvalSink,
      ...(agent !== undefined ? { agent } : {}),
      now: () => NOW,
    });
  }
  const interpreter = (value: Awaited<ReturnType<InquiryInterpreter["interpret"]>>): InquiryInterpreter => ({
    async interpret() {
      return value;
    },
  });
  const failingApprovals = (): ReceptionApprovalSink => ({
    recordPending() {
      throw new Error("approval storage unavailable");
    },
    list(status) {
      return approvals.list(status);
    },
  });
  const humanAgent = (target: number | undefined, needQuantity: number | undefined): ReceptionAgentRuntime => ({
    async run() {
      return {
        plan: {
          locale: "zh-CN",
          blocks: [
            {
              kind: "request_human_help",
              topic: "price_below_public_bound",
              ...(target !== undefined ? { buyerTargetPrice: target, currency: "CNY" } : {}),
            },
          ],
        },
        need: {
          sku: SKU,
          ...(needQuantity !== undefined ? { quantity: needQuantity } : {}),
          unit: "piece",
        },
        metrics: { steps: 1, toolCalls: {}, usage: { input: 0, output: 0, total: 0 } },
      };
    },
  });

  it("deterministic: target above public bound does not claim pending", async () => {
    const engine = engineFor(
      interpreter({
        intent: "quote_request",
        topics: ["price"],
        sku: SKU,
        quantity: 2,
        unit: "piece",
        target_price: 120,
        language: "zh",
      }),
    );
    const result = await engine.respond(input());
    expect(result.text).not.toContain("需要商家确认");
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("deterministic: missing quantity does not claim pending", async () => {
    const engine = engineFor(
      interpreter({
        intent: "quote_request",
        topics: ["price"],
        sku: SKU,
        unit: "piece",
        target_price: 98,
        language: "zh",
      }),
    );
    const result = await engine.respond(input("98 卖吗"));
    expect(result.text).not.toContain("需要商家确认");
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("deterministic: approval storage failure does not claim pending", async () => {
    const engine = engineFor(
      interpreter({
        intent: "quote_request",
        topics: ["price"],
        sku: SKU,
        quantity: 2,
        unit: "piece",
        target_price: 98,
        language: "zh",
      }),
      failingApprovals(),
    );
    const result = await engine.respond(input());
    expect(result.text).not.toContain("需要商家确认");
    expect(result.text).toContain("当前公开标价");
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("deterministic: verified pending allows the claim", async () => {
    const engine = engineFor(
      interpreter({
        intent: "quote_request",
        topics: ["price"],
        sku: SKU,
        quantity: 2,
        unit: "piece",
        target_price: 98,
        language: "zh",
      }),
    );
    const result = await engine.respond(input());
    expect(result.text).toContain("需要商家确认");
    expect(result.text).toContain("尚未批准");
    expect(approvals.list("pending")).toHaveLength(1);
  });

  it("agent: target above public bound does not claim pending", async () => {
    const engine = engineFor(undefined, approvals, humanAgent(120, 2));
    const result = await engine.respond(input("问价"));
    expect(result.text).not.toContain("需要商家确认");
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("agent: missing target price does not claim pending", async () => {
    const engine = engineFor(undefined, approvals, humanAgent(undefined, 2));
    const result = await engine.respond(input("问价"));
    expect(result.text).not.toContain("需要商家确认");
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("agent: missing quantity does not claim pending", async () => {
    const engine = engineFor(undefined, approvals, humanAgent(98, undefined));
    const result = await engine.respond(input("问价"));
    expect(result.text).not.toContain("需要商家确认");
    expect(approvals.list("pending")).toHaveLength(0);
    expect(result.text).toContain("请补充购买数量");
  });

  it("agent: approval storage failure does not claim pending", async () => {
    const engine = engineFor(undefined, failingApprovals(), humanAgent(98, 2));
    const result = await engine.respond(input("问价"));
    expect(result.text).not.toContain("需要商家确认");
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("agent: verified pending allows the claim", async () => {
    const engine = engineFor(undefined, approvals, humanAgent(98, 2));
    const result = await engine.respond(input("问价"));
    expect(result.text).toContain("需要商家确认");
    expect(approvals.list("pending")).toHaveLength(1);
  });
});
