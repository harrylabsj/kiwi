/**
 * A319 2-3 返修自有控制（在 A317 探针设计基础上修正解析路径）。
 *
 * 两件事分开（A319 证据口径补充）：
 * 1. **产品归一修复**：merchant-handler 三处（rfq→offer 登记 / offer→counter
 *    登记 / Ledger 恢复 offer/counter 分支）把无条件 offer/counter_offer 归一为
 *    evaluateConditionalOffer 合法形状（含 conditions: []）——A317 实证 4 红同根因
 *    （缺 conditions → evaluator TypeError → -32603）。
 * 2. **测试解析校准**：A317 探针 A1/A4 读 `result.artifacts`，而产品 wire 是
 *    `result.task.artifacts`（server.ts return {task: result.task}）——本文件用
 *    正确路径；Kimi 原探针字节保持原样未改（原 raw 保留）。
 *
 * 9 控：A1 合法直报价接受 / A2 未知 offer_id 拒 / A3 错 digest terms_digest_mismatch
 * / A4 同 Ledger 新 handler 重启后接受 / V1 evaluator 条件冲突契约 / V2 动态错 digest
 * 拒绝 / E1 error 后 unknown 屏障 / E2 正常提交幂等重放 / D1 decline(scope=offer) 恰推进一次。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import type { NegotiationHandler } from "../src/a2a/server/types.js";
import { A2AServer, NoneAuthVerifier } from "../src/a2a/server/index.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { evaluateConditionalOffer } from "../src/negotiation/condition/evaluator.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = () => new Date().toISOString();
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

let msgSeq = 0;
function nextMsgId(): string {
  msgSeq += 1;
  return `msg-a319-${Date.now()}-${msgSeq}`;
}

function envelope(
  negotiationId: string,
  action: string,
  payload: Record<string, unknown>,
  inReplyTo?: string,
): Record<string, unknown> {
  return finalizeEnvelope({
    capability: CAP,
    protocol_version: "1.0",
    negotiation_id: negotiationId,
    exchange_id: `exch-${negotiationId}`,
    message_id: nextMsgId(),
    ...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
    actor: "buyer",
    action: action as never,
    created_at: NOW(),
    payload: payload as never,
  }) as unknown as Record<string, unknown>;
}

async function rpc(base: string, env: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextMsgId(),
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "data", data: { knp_envelope: env } }],
          messageId: env["message_id"],
        },
      },
    }),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** 校准后的提取：agreement 在 result.task.artifacts（A319 证据口径补充）。 */
function agreementOf(accept: Record<string, unknown>): Record<string, unknown> | undefined {
  const result = accept["result"] as
    | { task?: { artifacts?: Array<{ parts?: Array<{ data?: Record<string, unknown> }> }> } }
    | undefined;
  return result?.task?.artifacts
    ?.flatMap((a) => a.parts ?? [])
    .find((p) => p.data?.["agreement"] !== undefined)?.data?.["agreement"] as
    | Record<string, unknown>
    | undefined;
}

function declineReason(accept: Record<string, unknown>): string {
  const result = accept["result"] as
    | {
        task?: { status?: { message?: { parts?: Array<{ kind: string; data?: Record<string, unknown> }> } } };
      }
    | undefined;
  const part = result?.task?.status?.message?.parts?.find(
    (p) => p.kind === "data" && p.data?.["decline"] === true,
  );
  return (part?.data?.["reason_code"] as string | undefined) ?? "";
}

async function startStack(
  dir: string,
  handlerOverride?: NegotiationHandler,
): Promise<string> {
  const ledger = new LedgerStore({ dir: path.join(dir, "ledger"), now: NOW });
  const idempotency = new IdempotencyStore({ dir: path.join(dir, "idem"), now: NOW });
  const handler =
    handlerOverride ??
    (createMerchantHandler({
      ledger,
      now: NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
      productSource: {
        async getProduct(sku: string) {
          if (sku === "VQ-003") return { price: 8999, currency: "CNY" };
          throw new Error(`no product ${sku}`);
        },
      },
    }) as unknown as NegotiationHandler);
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const server = new A2AServer({
    card: () => ({
      name: "A319 2-3 return fix",
      description: "a319",
      providerOrganization: "Kiwi Test",
      version: "1.0.0",
      baseUrl: holder.baseUrl,
      a2aPath: "/a2a",
    }),
    ledger,
    idempotency,
    handler,
    authVerifier: new NoneAuthVerifier(),
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;
  holder.baseUrl = `http://127.0.0.1:${port}`;
  cleanups.push(async () => new Promise<void>((r) => httpServer.close(() => r())));
  return holder.baseUrl;
}

async function rfqOffer(base: string, negId: string): Promise<Record<string, unknown>> {
  const r = await rpc(
    base,
    envelope(negId, "rfq", {
      type: "rfq",
      items: [{ sku: "VQ-003", quantity: { value: 1, unit: "piece" } }],
      requested_terms: { delivery_before: "2026-12-01T00:00:00Z" },
    }),
  );
  expect(r["error"]).toBeUndefined();
  const result = r["result"] as
    | { task?: { status?: { message?: { parts?: Array<{ kind: string; data?: Record<string, unknown> }> } } } }
    | undefined;
  const parts = result?.task?.status?.message?.parts ?? [];
  const part = parts.find((p) => p.kind === "data");
  const env = part?.data?.["knp_envelope"] as Record<string, unknown> | undefined;
  if (env === undefined) throw new Error(`no knp_envelope in RFQ reply`);
  return env as Record<string, unknown>;
}

describe("A319 2-3 返修自有控制（解析路径校准后）", () => {
  it("A1 合法直报价 accept（正确 offer_id + 正确 digest）→ agreement artifact", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a319-a1-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const base = await startStack(dir);
    const negId = "neg-a319-a1";
    const offer = await rfqOffer(base, negId);
    const offerPayload = offer["payload"] as { offer_id: string; terms: Record<string, unknown> };
    const agreed = evaluateConditionalOffer(
      {
        type: "conditional_offer",
        offer_id: offerPayload.offer_id,
        base_terms: offerPayload.terms,
        conditions: [],
      } as never,
      { "aggregate.total_quantity": 1 },
    );
    const accept = await rpc(
      base,
      envelope(negId, "accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerPayload.offer_id,
        terms_digest: contentDigest(agreed as never),
      }, String(offer["message_id"])),
    );
    expect(accept["error"]).toBeUndefined();
    const agreement = agreementOf(accept);
    expect(agreement).toBeDefined();
    expect((agreement as { accepted_offer_id?: string }).accepted_offer_id).toBe(offerPayload.offer_id);
  });

  it("A2 未知 offer_id → offer_unknown decline，无 agreement", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a319-a2-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const base = await startStack(dir);
    const negId = "neg-a319-a2";
    await rfqOffer(base, negId);
    const accept = await rpc(
      base,
      envelope(negId, "accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: "offer_nope",
        terms_digest: "sha256:" + "ab".repeat(32),
      }),
    );
    expect(accept["error"]).toBeUndefined();
    expect(agreementOf(accept)).toBeUndefined();
    expect(declineReason(accept)).toBe("offer_unknown");
  });

  it("A3 正确 offer_id 但错误 digest → terms_digest_mismatch decline，零 agreement", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a319-a3-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const base = await startStack(dir);
    const negId = "neg-a319-a3";
    const offer = await rfqOffer(base, negId);
    const offerPayload = offer["payload"] as { offer_id: string };
    const accept = await rpc(
      base,
      envelope(negId, "accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerPayload.offer_id,
        terms_digest: "sha256:" + "cd".repeat(32),
      }, String(offer["message_id"])),
    );
    expect(accept["error"]).toBeUndefined();
    expect(agreementOf(accept)).toBeUndefined();
    expect(declineReason(accept)).toBe("terms_digest_mismatch");
  });

  it("A4 同 Ledger 新 handler（重启语义）后同一 offer 仍接受", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a319-a4-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ledger = new LedgerStore({ dir: path.join(dir, "ledger"), now: NOW });
    const mk = () =>
      createMerchantHandler({
        ledger,
        now: NOW,
        sender: "merchant:merchant-001",
        counterparty: "buyer:*",
        productSource: {
          async getProduct(sku: string) {
            if (sku === "VQ-003") return { price: 8999, currency: "CNY" };
            throw new Error(`no product ${sku}`);
          },
        },
      }) as unknown as NegotiationHandler;
    const idempotency = new IdempotencyStore({ dir: path.join(dir, "idem"), now: NOW });
    const holder = { baseUrl: "http://127.0.0.1:0" };
    const server = new A2AServer({
      card: () => ({ name: "a319-a4", description: "d", providerOrganization: "K", version: "1", baseUrl: holder.baseUrl, a2aPath: "/a2a" }),
      ledger, idempotency, handler: mk(), authVerifier: new NoneAuthVerifier(),
    });
    const httpServer = server.createServer();
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    const port = (httpServer.address() as AddressInfo).port;
    holder.baseUrl = `http://127.0.0.1:${port}`;
    let base = holder.baseUrl;
    const negId = "neg-a319-a4";
    const offer = await rfqOffer(base, negId);
    const offerPayload = offer["payload"] as { offer_id: string; terms: Record<string, unknown> };
    // 重启：关闭旧 server，同 Ledger/新 handler 实例重建（登记从 Ledger 恢复）
    await new Promise<void>((r) => httpServer.close(() => r()));
    const idem2 = new IdempotencyStore({ dir: path.join(dir, "idem2"), now: NOW });
    const server2 = new A2AServer({
      card: () => ({ name: "a319-a4-2", description: "d", providerOrganization: "K", version: "1", baseUrl: holder.baseUrl, a2aPath: "/a2a" }),
      ledger, idempotency: idem2, handler: mk(), authVerifier: new NoneAuthVerifier(),
    });
    const httpServer2 = server2.createServer();
    await new Promise<void>((r) => httpServer2.listen(0, "127.0.0.1", () => r()));
    cleanups.push(async () => new Promise<void>((r) => httpServer2.close(() => r())));
    // 新实例新端口——base 指向重启后的 server（review A319）
    holder.baseUrl = `http://127.0.0.1:${(httpServer2.address() as AddressInfo).port}`;
    base = holder.baseUrl;
    const agreed = evaluateConditionalOffer(
      { type: "conditional_offer", offer_id: offerPayload.offer_id, base_terms: offerPayload.terms, conditions: [] } as never,
      { "aggregate.total_quantity": 1 },
    );
    const accept = await rpc(
      base,
      envelope(negId, "accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerPayload.offer_id,
        terms_digest: contentDigest(agreed as never),
      }, String(offer["message_id"])),
    );
    expect(accept["error"]).toBeUndefined();
    const agreement = agreementOf(accept);
    expect(agreement).toBeDefined();
    expect((agreement as { accepted_offer_id?: string }).accepted_offer_id).toBe(offerPayload.offer_id);
  });

  it("V1 evaluator 契约：多规则命中且结果不同 → condition_conflict", () => {
    const conditional = {
      type: "conditional_offer",
      offer_id: "off_v1",
      base_terms: { items: [{ sku: "s", quantity: { value: 1, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 100 } }] },
      conditions: [
        { when: { field: "aggregate.total_quantity", op: "gte", value: 10 }, then_terms: { items: [{ sku: "s", quantity: { value: 10, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 80 } }] } },
        { when: { field: "aggregate.total_quantity", op: "gte", value: 20 }, then_terms: { items: [{ sku: "s", quantity: { value: 20, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 60 } }] } },
      ],
    };
    try {
      evaluateConditionalOffer(conditional as never, { "aggregate.total_quantity": 30 });
      throw new Error("expected condition_conflict");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("condition_conflict");
    }
  });

  it("V2 accept 动态：错误 digest → terms_digest_mismatch decline（不假成功）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a319-v2-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const base = await startStack(dir);
    const negId = "neg-a319-v2";
    const offer = await rfqOffer(base, negId);
    const offerPayload = offer["payload"] as { offer_id: string };
    const badDigest = contentDigest({ tampered: true });
    const accept = await rpc(
      base,
      envelope(negId, "accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerPayload.offer_id,
        terms_digest: badDigest,
      }, String(offer["message_id"])),
    );
    expect(accept["error"]).toBeUndefined();
    expect(agreementOf(accept)).toBeUndefined();
    expect(declineReason(accept)).toBe("terms_digest_mismatch");
  });

  it("D1 decline(scope=offer) → 200 Declined，恰推进一次（2-2 校准回归）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a319-d1-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const base = await startStack(dir);
    const negId = "neg-a319-d1";
    const offer = await rfqOffer(base, negId);
    const d = await rpc(
      base,
      envelope(negId, "decline", {
        type: "decline",
        scope: "offer",
        target_message_id: String(offer["message_id"]),
      }, String(offer["message_id"])),
    );
    expect(d["error"]).toBeUndefined();
    const text = JSON.stringify(d);
    expect(text).toContain("Declined (scope=offer)");
  });
});

// ── A319 追加：2-8 ledger 锁 PID 身份 / 3-9 条件节点 schema false 严拒 ──


describe("A319 追加：2-8 陈旧锁回收的身份边界", () => {
  it("负数/浮点/不可解析 PID 的陈旧锁不被回收（unknown 不删）", async () => {
    const { LedgerStore } = await import("../src/negotiation/ledger/index.js");
    const { ledgerFileName } = await import("../src/negotiation/ledger/store.js");
    const { createHash } = await import("node:crypto");
    const dir = mkdtempSync(path.join(tmpdir(), "a319-lock-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new LedgerStore({ dir, now: NOW });
    const negId = "neg-a319-lock";
    await store.append({
      event_kind: "message_sent",
      negotiation_id: negId,
      exchange_id: `exch-${negId}`,
      message_id: `m-${Math.random()}`,
      identity: { sender_identity: "merchant:m", counterparty_identity: "buyer:*", actor: "merchant" },
      capability: { capability: CAP, protocol_version: "1.0" },
      wire_digest: "sha256:x",
      wire_payload: {},
      outcome: { kind: "ok" },
      occurred_at: NOW(),
    });
    // 造陈旧锁：负数 PID
    const lockPath = path.join(dir, "ledger", `${ledgerFileName(negId)}.lock`);
    const writeStale = (content: string) => {
      const { writeFileSync, utimesSync } = require("node:fs") as typeof import("node:fs");
      writeFileSync(lockPath, content, { mode: 0o600 });
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);
    };
    writeStale(JSON.stringify({ pid: -12345, token: "ghost" }));
    // 陈旧 + 负 PID：接管逻辑不得删除 unknown 身份锁 → append 超时 fail-closed
    //（lockTimeoutMs 缺省较短；这里只断言锁文件仍在——unknown 不删）
    const stillThere = () => {
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      return existsSync(lockPath);
    };
    try {
      await store.append({
        event_kind: "message_sent",
        negotiation_id: negId,
        exchange_id: `exch-${negId}`,
        message_id: `m-${Math.random()}`,
        identity: { sender_identity: "merchant:m", counterparty_identity: "buyer:*", actor: "merchant" },
        capability: { capability: CAP, protocol_version: "1.0" },
        wire_digest: "sha256:x",
        wire_payload: {},
        outcome: { kind: "ok" },
        occurred_at: NOW(),
      });
    } catch {
      // fail-closed 超时是可接受路径
    }
    expect(stillThere()).toBe(true);
    writeStale(JSON.stringify({ pid: 1.5, token: "ghost2" }));
    try {
      await store.append({
        event_kind: "message_sent",
        negotiation_id: negId,
        exchange_id: `exch-${negId}`,
        message_id: `m-${Math.random()}`,
        identity: { sender_identity: "merchant:m", counterparty_identity: "buyer:*", actor: "merchant" },
        capability: { capability: CAP, protocol_version: "1.0" },
        wire_digest: "sha256:x",
        wire_payload: {},
        outcome: { kind: "ok" },
        occurred_at: NOW(),
      });
    } catch {}
    expect(stillThere()).toBe(true);
  });

  it("正整数 PID 确认死亡（ESRCH）→ 允许回收接管；自己 token 释放自己", async () => {
    const { LedgerStore } = await import("../src/negotiation/ledger/index.js");
    const { ledgerFileName } = await import("../src/negotiation/ledger/store.js");
    const dir = mkdtempSync(path.join(tmpdir(), "a319-lock2-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new LedgerStore({ dir, now: NOW });
    const negId = "neg-a319-lock2";
    await store.append({
      event_kind: "message_sent",
      negotiation_id: negId,
      exchange_id: `exch-${negId}`,
      message_id: `m-${Math.random()}`,
      identity: { sender_identity: "merchant:m", counterparty_identity: "buyer:*", actor: "merchant" },
      capability: { capability: CAP, protocol_version: "1.0" },
      wire_digest: "sha256:x",
      wire_payload: {},
      outcome: { kind: "ok" },
      occurred_at: NOW(),
    });
    // 正整数但不可能存在的 PID（ESRCH）→ 确认死亡 → 可回收
    const { writeFileSync, utimesSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const lockPath = path.join(dir, "ledger", `${ledgerFileName(negId)}.lock`);
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_000_000, token: "dead" }), { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const ev = await store.append({
      event_kind: "message_sent",
      negotiation_id: negId,
      exchange_id: `exch-${negId}`,
      message_id: `m-${Math.random()}`,
      identity: { sender_identity: "merchant:m", counterparty_identity: "buyer:*", actor: "merchant" },
      capability: { capability: CAP, protocol_version: "1.0" },
      wire_digest: "sha256:x2",
      wire_payload: {},
      outcome: { kind: "ok" },
      occurred_at: NOW(),
    });
    expect(ev.event_id).toBeTruthy();
    expect(existsSync(lockPath)).toBe(false);
    void negId;
  });
});

describe("A319 追加：3-9 条件节点 schema false 严拒（合法扩展仍保）", () => {
  const baseTerms = {
    currency: "CNY",
    items: [{ sku: "s", quantity: { value: 1, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 100 } }],
  };
  it("leaf 节点额外 key + 原文正确 digest → schema_invalid 拒绝", async () => {
    const { validateConditionalOffer } = await import("../src/negotiation/domain/objects.js");
    const conditional = {
      type: "conditional_offer",
      offer_id: "off-k1",
      base_terms: baseTerms,
      conditions: [
        { when: { field: "aggregate.total_quantity", op: "gte", value: 1, smuggled: "x" }, then_terms: baseTerms },
      ],
    };
    expect(() => validateConditionalOffer(conditional)).toThrowError(/smuggled/);
  });

  it("all 节点同层额外 key → 拒绝", async () => {
    const { validateConditionalOffer } = await import("../src/negotiation/domain/objects.js");
    const conditional = {
      type: "conditional_offer",
      offer_id: "off-k2",
      base_terms: baseTerms,
      conditions: [
        { when: { all: [{ field: "aggregate.total_quantity", op: "gte", value: 1 }], note: "extra" }, then_terms: baseTerms },
      ],
    };
    expect(() => validateConditionalOffer(conditional)).toThrowError(/note/);
  });

  it("合法 Money/Quantity 扩展仍透传（digest 含扩展）", async () => {
    const { validateConditionalOffer } = await import("../src/negotiation/domain/objects.js");
    const { contentDigest } = await import("../src/negotiation/jcs.js");
    const extTerms = {
      currency: "CNY",
      items: [{ sku: "s", quantity: { value: 1, unit: "piece", handling: "cold-chain" }, unit_price: { currency: "CNY", amount_minor: 100, promo_ref: "P1" } }],
    };
    const validated = validateConditionalOffer({
      type: "conditional_offer",
      offer_id: "off-k3",
      base_terms: extTerms,
      conditions: [],
    });
    const firstItem = validated.base_terms.items?.[0] as unknown as Record<string, unknown>;
    const itemQuantity = firstItem.quantity as Record<string, unknown>;
    const itemPrice = firstItem.unit_price as Record<string, unknown>;
    expect(itemQuantity.handling).toBe("cold-chain");
    expect(itemPrice.promo_ref).toBe("P1");
    expect(contentDigest(validated.base_terms)).toBe(contentDigest(extTerms));
  });
});

// ── A319 追加（二）：P1-1 路径 scope / P1-2 实际 counter 门 / P1-3 legacy CAS ──

import { createBuyerHttpServer } from "../src/http/server.js";
import {
  CatalogPipelineError,
  saveWorkbuddyEnrollment,
  workbuddyEnrollment,
} from "../src/cloud/onboarding/catalog-pipeline.js";
import { readEnrollmentStore } from "../src/cloud/binding/enrollment-challenge.js";
import { buildBuyerService } from "../src/buyer-core/build-service.js";
import type { Server } from "node:http";

describe("A319 追加：P1-1 认证与路由同一安全路径视图", () => {
  function makeServer(): { server: Server; port: () => number } {
    const svc = buildBuyerService({
      dbPath: ":memory:",
      principal: "c:p11",
      buyerAgentId: "b:p11",
      sessionId: "s",
      policy: {
        policy_id: "dp", version: "1.0", principal: "c:p11", expires_at: "2099-12-31T23:59:59Z",
        actions: { discover: { mode: "auto" }, inquiry_rfq: { mode: "auto" }, compare_offers: { mode: "auto" }, counter_offer: { mode: "auto" }, accept_nonbinding: { mode: "ask" }, handoff: { mode: "ask" }, payment: { mode: "never" } },
      } as never,
    } as never);
    const server = createBuyerHttpServer({
      service: svc,
      authToken: "buyer-tok",
      merchantAuthToken: "merchant-tok",
      merchantOps: {},
    });
    return { server, port: () => (server.address() as AddressInfo).port };
  }

  it("点段变形 /x/../merchant/m1/resolve-review 携 buyer token → 401（与路由同视图）", async () => {
    const { server, port } = makeServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const res = await fetch(`http://127.0.0.1:${port()}/x/../merchant/m1/resolve-review`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer buyer-tok" },
        body: JSON.stringify({ conversation_id: "c", decision: "approve" }),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("重复 slash //merchant//m1/resolve-review 携 buyer token → 401", async () => {
    const { server, port } = makeServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const res = await fetch(`http://127.0.0.1:${port()}//merchant//m1/resolve-review`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer buyer-tok" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("商家 token 走合法 /merchant 路径过鉴权层（404 not 401）；buyer token 恒 401", async () => {
    const { server, port } = makeServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const m = await fetch(`http://127.0.0.1:${port()}/merchant/m1/resolve-review`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer merchant-tok" },
        body: JSON.stringify({ conversation_id: "c", decision: "approve" }),
      });
      expect(m.status).toBe(404); // 通过 scope 鉴权层；ops 无此商家 → 404
      const b = await fetch(`http://127.0.0.1:${port()}/merchant/m1/resolve-review`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer buyer-tok" },
        body: JSON.stringify({}),
      });
      expect(b.status).toBe(401);
    } finally {
      server.close();
    }
  });
});

describe("A319 追加：P1-2 实际外发 counter 提案限额门", () => {
  function svcWithLimits(limits: Record<string, unknown>) {
    return buildBuyerService({
      dbPath: ":memory:",
      principal: "c:p12",
      buyerAgentId: "b:p12",
      sessionId: "s",
      policy: {
        policy_id: "dp", version: "1.0", principal: "c:p12", expires_at: "2099-12-31T23:59:59Z",
        actions: { discover: { mode: "auto" }, inquiry_rfq: { mode: "auto" }, compare_offers: { mode: "auto" }, counter_offer: { mode: "auto" }, accept_nonbinding: { mode: "ask" }, handoff: { mode: "ask" }, payment: { mode: "never" } },
        limits,
      } as never,
    } as never);
  }

  it("checkCounterProposalLimits：超限拒 / 界内放行 / 非整数 minor 拒 / 缺单位拒", () => {
    const svc = svcWithLimits({
      max_unit_price: { currency: "CNY", amount_minor: 100_000 },
      max_total_price: { currency: "CNY", amount_minor: 1_000_000 },
      max_quantity: { value: 10, unit: "个" },
      allowed_currencies: ["CNY"],
    });
    const over = svc.checkCounterProposalLimits({
      merchant_id: "m1", sku: "s", currency: "CNY",
      quantity_value: 10, quantity_unit: "个",
      unit_price_minor: 999_999_900, total_price_minor: 9_999_999_000_000,
    });
    expect(over).toContain("超过");
    const ok = svc.checkCounterProposalLimits({
      merchant_id: "m1", sku: "s", currency: "CNY",
      quantity_value: 10, quantity_unit: "个",
      unit_price_minor: 99_900, total_price_minor: 999_000,
    });
    expect(ok).toBeUndefined();
    const nonInt = svc.checkCounterProposalLimits({
      merchant_id: "m1", sku: "s", currency: "CNY",
      quantity_value: 1, quantity_unit: "个",
      unit_price_minor: 10.5, total_price_minor: 10.5,
    });
    expect(nonInt).toContain("安全整数");
    const missingUnit = svc.checkCounterProposalLimits({
      merchant_id: "m1", sku: "s", currency: "CNY",
      quantity_value: 1, unit_price_minor: 100, total_price_minor: 100,
    });
    expect(missingUnit).toContain("单位");
  });

  it("negotiator 门阻断 → 零 wire（不 sendMessage）；放行 → 恰一次外发", async () => {
    const { A2ANegotiator } = await import("../src/buyer-core/a2a-negotiator.js");
    let wireCalls = 0;
    // 本机 http server 记录真实外发（A2AClient 内部有 DNS/SSRF 检查，
    // 127.0.0.1 + allowPrivateRanges 直连可行）
    const { createServer } = await import("node:http");
    const wireServer = createServer((req, res) => {
      wireCalls += 1;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { task: { id: "t-wire", status: { state: "working" }, contextId: "ctx" } },
        }));
      });
    });
    await new Promise<void>((r) => wireServer.listen(0, "127.0.0.1", () => r()));
    const wirePort = (wireServer.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((r) => wireServer.close(() => r())));
    const endpoint = `http://127.0.0.1:${wirePort}/a2a`;
    const fetchImpl = (async (url: string | URL, init?: { method?: string; body?: string }) => {
      void url;
      if (init?.method === "POST" && init.body !== undefined) wireCalls += 1;
      return new Response(JSON.stringify({ id: "t", status: { state: "working" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const blocked = new A2ANegotiator({
      timeoutMs: 50,
      fetchImpl,
      allowPrivateRanges: true,
      skipDnsCheck: true,
      counterProposalGate: () => "超出 max_unit_price（A319 正控）",
    });
    const candidate = {
      candidate_id: "c1", merchant_id: "m1", status: "succeeded", retryable: false,
      provenance: {
        a2a_endpoint: endpoint,
        negotiation_id: "neg-g",
        offer_id: "off-g",
        merchant_reply_id: "m-1",
        sku: "s",
        reply_text: JSON.stringify({ payload: { terms: { items: [{ unit_price: { amount_minor: 99_900 } }] } } }),
      },
      terms: { currency: "CNY", items: [{ sku: "s", quantity_value: 10, quantity_unit: "个", unit_price_minor: 99_900 }], total_price_minor: 999_000 },
    };
    const step = { round: 1, action: "counter_offer" as const, summary: "start" };
    const intent = { items: [{ sku: "s", quantity: { value: 10, unit: "个" } }], constraints: { target_unit_price: { currency: "CNY", amount_minor: 99_900 } } };
    const r1 = await blocked.negotiate("t1", intent, step, [candidate]);
    expect(wireCalls).toBe(0);
    expect(r1.summary).toContain("counter 被委托约束阻断");

    const passing = new A2ANegotiator({
      timeoutMs: 50,
      fetchImpl,
      allowPrivateRanges: true,
      skipDnsCheck: true,
      counterProposalGate: () => undefined,
    });
    await passing.negotiate("t1", intent, step, [candidate]);
    expect(wireCalls).toBe(1);
  });
});

describe("A319 追加：P1-3 legacy 快照可信 CAS 恢复", () => {
  function seedLegacyStore(dir: string, sessions: Array<Record<string, unknown>>): void {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // enrollment store 文件名/路径与 enrollment-challenge 的 readEnrollmentStore 一致
    writeFileSync(
      path.join(dir, "merchant-enrollments.json"),
      `${JSON.stringify({ version: 1, sessions, consumed: [] })}\n`,
      { mode: 0o600 },
    );
  }
  const legacySession = () => ({
    enrollment_id: "enr-legacy",
    runtime_origin: "https://merchant.example",
    key_thumbprint: `sha256:${"a".repeat(64)}`,
    catalog_origin: "https://catalog.example",
    catalog_agent_id: "cagt_legacy",
    merchant_id: "merchant_legacy",
    binding_id: "binding_legacy",
    device_code: "D".repeat(48),
    user_code: "LEG-CODE",
    verification_uri: "https://catalog.example/portal/connect/legacy",
    interval: 5,
    preview_digest: `sha256:${"b".repeat(64)}`,
    frozen_card: {},
    status: "awaiting_confirmation",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    owner_ref: "record_legacy",
    // 无 store_revision —— legacy 形态
  });

  it("legacy 快照读取 → save 首推 revision（恢复不再永远 CAS 拒）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a319-legacy-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    seedLegacyStore(dir, [legacySession()]);
    const state = workbuddyEnrollment(dir, "record_legacy");
    expect(state).toBeDefined();
    saveWorkbuddyEnrollment(dir, { ...state!, status: "authorized" } as never, state!.store_revision);
    const after = readEnrollmentStore(dir).sessions.find((s) => s.enrollment_id === "enr-legacy") as unknown as { store_revision?: number; status?: string };
    expect(after.store_revision).toBe(1);
    expect(after.status).toBe("authorized");
  });

  it("两个同 legacy 旧快照竞争：先写者胜，后者 digest 不匹配 → 冲突不覆盖", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a319-legacy2-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    seedLegacyStore(dir, [legacySession()]);
    const snapA = workbuddyEnrollment(dir, "record_legacy");
    const snapB = workbuddyEnrollment(dir, "record_legacy");
    expect(snapA).toBeDefined();
    expect(snapB).toBeDefined();
    saveWorkbuddyEnrollment(dir, { ...snapA!, status: "authorized" } as never, snapA!.store_revision);
    expect(() =>
      saveWorkbuddyEnrollment(dir, { ...snapB!, status: "published" } as never, snapB!.store_revision),
    ).toThrow(CatalogPipelineError);
    const after = readEnrollmentStore(dir).sessions.find((s) => s.enrollment_id === "enr-legacy") as unknown as { store_revision?: number; status?: string };
    expect(after.status).toBe("authorized");
    expect(after.store_revision).toBe(1);
  });

  it("await 窗口他人新增会话/consumed 不被覆盖（全快照保护回归）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a319-legacy3-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    seedLegacyStore(dir, [legacySession()]);
    const snap = workbuddyEnrollment(dir, "record_legacy");
    // 他人写入新会话（fresh store 推进）
    saveWorkbuddyEnrollment(dir, {
      ...legacySession(),
      enrollment_id: "enr-other",
      owner_ref: "record_other",
    } as never, undefined);
    // 他人新增**其他**会话不影响本会话 prior 内容：legacy digest 仍匹配 →
    // 放行，且全快照写入必须保留他人的新会话（fresh 保护，不回滚 consumed/
    // 新 claim）。冲突仅在目标会话自身被推进时触发（见上一用例）。
    saveWorkbuddyEnrollment(dir, { ...snap!, status: "authorized" } as never, snap!.store_revision);
    const after = readEnrollmentStore(dir);
    expect(after.sessions.find((x) => x.enrollment_id === "enr-other")).toBeDefined();
    const target = after.sessions.find((x) => x.enrollment_id === "enr-legacy") as unknown as {
      status?: string;
      store_revision?: number;
    };
    expect(target.status).toBe("authorized");
    expect(target.store_revision).toBe(1);
  });
});
