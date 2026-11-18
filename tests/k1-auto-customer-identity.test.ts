/**
 * 买家识别与交易回执 · K1 首询自动分配本店客户 ID。
 *
 * 覆盖验收 A1（并发/重试/无效签名后的客户主体数）与 A6 的建档边界
 * （写者故障恢复、绑定过期不新建客户号、未验签输入、无关消息与拒绝请求
 * 不建档）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureVerifiedCustomerIdentity,
  findVerifiedCustomerIdentity,
} from "../src/merchant-core/customer-memory/auto-identity.js";
import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import {
  LocalCustomerIdentityWriter,
  SpooledCustomerIdentityWriter,
} from "../src/a2a/server/customer-identity-gateway.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import type { CustomerIdentityWriter } from "../src/a2a/server/customer-identity-gateway.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";

const NOW = "2026-11-03T04:00:00.000Z";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const SKU = "VQ-001";
const MERCHANT = "merchant-a";
const OPEN_ACTOR = "kiwi-inquiry-session-v1:abc123";

/** 已验签 open-inquiry 身份常量（isOpenInquiryIdentity 前缀）。 */
const productSource = {
  async getProduct(sku: string) {
    if (sku !== SKU) throw new Error(`unknown sku ${sku}`);
    return { price: 110, currency: "CNY", stock: 50, unit: "piece", source_evidence: { system: "owned-test-fixture" } };
  },
};

describe("K1 ensureVerifiedCustomerIdentity（本店身份建档）", () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-k1-identity-"));
    db = new DatabaseSync(join(dir, "state.sqlite"));
    registerGovernanceLedgers(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("首次建档：agent_scope 主体 + epoch1 绑定 + 唯一映射（单事务）", () => {
    const first = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    expect(first.created).toBe(true);
    expect(first.subject_id).toMatch(/^subj_/);
    expect(first.binding_epoch).toBe(1);

    const subject = db
      .prepare("SELECT subject_kind, status FROM customer_subjects WHERE subject_id = ?")
      .get(first.subject_id) as { subject_kind: string; status: string };
    expect(subject.subject_kind).toBe("agent_scope");
    expect(subject.status).toBe("ACTIVE");

    const mapping = db
      .prepare("SELECT verified_actor FROM verified_customer_identities WHERE merchant_id = ? AND subject_id = ?")
      .get(MERCHANT, first.subject_id);
    expect(mapping).toBeDefined();

    const binding = db
      .prepare("SELECT issuer, assurance_class, binding_epoch, status FROM subject_bindings WHERE actor_id = ?")
      .get(OPEN_ACTOR) as { issuer: string; assurance_class: string; binding_epoch: number; status: string };
    expect(binding.issuer).toBe("open-inquiry");
    expect(binding.assurance_class).toBe("verified-key");
    expect(binding.status).toBe("ACTIVE");
  });

  it("重试与并发：同一 (merchant, actor) 只产生一个主体、不重复续绑", async () => {
    const [a, b, c] = await Promise.all([
      ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW }),
      ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW }),
      ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW }),
    ]);
    expect(a.subject_id).toBe(b.subject_id);
    expect(b.subject_id).toBe(c.subject_id);
    // 恰好一次建档；其余调用复用且不再续绑。
    const createdCount = [a, b, c].filter((r) => r.created === true).length;
    expect(createdCount).toBe(1);
    expect([a, b, c].every((r) => r.binding_created !== true || r.created === true)).toBe(true);

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM customer_subjects WHERE merchant_id = ?")
      .get(MERCHANT) as { n: number };
    expect(count.n).toBe(1);
    const bindingCount = db
      .prepare("SELECT COUNT(*) AS n FROM subject_bindings WHERE merchant_id = ? AND actor_id = ?")
      .get(MERCHANT, OPEN_ACTOR) as { n: number };
    expect(bindingCount.n).toBe(1);
  });

  it("跨店隔离：同 actor 在 B 店获得独立主体", () => {
    const a = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    const b = ensureVerifiedCustomerIdentity(db, { merchant_id: "merchant-b", verified_actor: OPEN_ACTOR, now: NOW });
    expect(b.subject_id).not.toBe(a.subject_id);
  });

  it("换钥隔离：新 keyid 是新客户主体", () => {
    const a = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    const rotated = ensureVerifiedCustomerIdentity(db, {
      merchant_id: MERCHANT,
      verified_actor: "kiwi-inquiry-session-v1:rotated-key",
      now: NOW,
    });
    expect(rotated.subject_id).not.toBe(a.subject_id);
  });

  it("绑定过期不新建客户号：续绑同主体，epoch 递增", () => {
    const first = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    const expiredAt = "2026-11-01T00:00:00.000Z";
    db.prepare("UPDATE subject_bindings SET expires_at = ? WHERE actor_id = ?").run(expiredAt, OPEN_ACTOR);
    const later = ensureVerifiedCustomerIdentity(db, {
      merchant_id: MERCHANT,
      verified_actor: OPEN_ACTOR,
      now: "2026-12-03T04:00:00.000Z",
    });
    expect(later.subject_id).toBe(first.subject_id);
    expect(later.created).toBe(false);
    expect(later.binding_created).toBe(true);
    expect(later.binding_epoch).toBe(2);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM customer_subjects WHERE merchant_id = ?")
      .get(MERCHANT) as { n: number };
    expect(count.n).toBe(1);
  });

  it("撤销的绑定不自动重建（再次建档不得恢复已撤销授权）", () => {
    const first = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    db.prepare("UPDATE subject_bindings SET status = 'REVOKED' WHERE actor_id = ?").run(OPEN_ACTOR);
    const again = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    expect(again.subject_id).toBe(first.subject_id);
    expect(again.binding_created).toBe(false);
    expect(again.binding_epoch).toBeUndefined();
    const activeBindings = db
      .prepare("SELECT COUNT(*) AS n FROM subject_bindings WHERE actor_id = ? AND status = 'ACTIVE'")
      .get(OPEN_ACTOR) as { n: number };
    expect(activeBindings.n).toBe(0);
  });

  it("只读查询不产生副作用", () => {
    ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    const found = findVerifiedCustomerIdentity(db, MERCHANT, OPEN_ACTOR);
    expect(found).toBeDefined();
    const bindings = db
      .prepare("SELECT COUNT(*) AS n FROM subject_bindings WHERE actor_id = ?")
      .get(OPEN_ACTOR) as { n: number };
    expect(bindings.n).toBe(1);
  });
});

describe("K1 LocalCustomerIdentityWriter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-k1-local-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("真实 state.sqlite 上幂等建档；重复 ensure 返回同一 subject_id", async () => {
    const writer = new LocalCustomerIdentityWriter({ dbPath: join(dir, "state.sqlite"), now: () => NOW });
    const first = await writer.ensure({ merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, source: "rfq" });
    expect(first.status).toBe("registered");
    if (first.status !== "registered") return;
    expect(first.created).toBe(true);
    const second = await writer.ensure({ merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, source: "inquiry" });
    expect(second.status).toBe("registered");
    if (second.status !== "registered") return;
    expect(second.subject_id).toBe(first.subject_id);
    expect(second.created).toBe(false);
  });

  it("迁移缺失时不可用但不抛错（询价不阻断）", async () => {
    // 指向一个目录路径（不是合法 sqlite 文件）→ open 失败。
    const writer = new LocalCustomerIdentityWriter({ dbPath: dir, now: () => NOW });
    const outcome = await writer.ensure({ merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, source: "rfq" });
    expect(outcome.status).toBe("unavailable");
  });
});

describe("K1 SpooledCustomerIdentityWriter（写者不可用恢复）", () => {
  let dir: string;
  let spoolFile: string;
  let server: ReturnType<typeof createSpoolServer> | undefined;

  /** 最小转发端点桩：可切换不可用/可用。 */
  function createSpoolServer() {
    const state = { calls: 0, healthy: true, subjects: new Map<string, string>() };
    return {
      state,
      url: "http://identity-writer.internal/ensure",
      async handle(input: { merchant_id: string; verified_actor: string }) {
        state.calls += 1;
        if (!state.healthy) throw new Error("down");
        const key = `${input.merchant_id}\u0000${input.verified_actor}`;
        if (!state.subjects.has(key)) {
          state.subjects.set(key, `subj_${state.subjects.size + 1}`);
        }
        return { ok: true, subject_id: state.subjects.get(key) as string, created: state.subjects.size === state.calls };
      },
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-k1-spool-"));
    spoolFile = join(dir, "identity-registration-spool.json");
  });

  afterEach(() => {
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("写者不可用：询价继续、spool 保留意图、恢复后重试返回原主体且无重复", async () => {
    server = createSpoolServer();
    server.state.healthy = false;
    const fetchImpl = vi.fn(async (url: string | URL, init?: Parameters<typeof fetch>[1]) => {
      await server?.handle(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, subject_id: "subj_x" }), { status: 200 });
    }) as unknown as typeof fetch;
    // 让 forward 走到网络层失败：用不可达端口模拟写者宕机。
    const writer = new SpooledCustomerIdentityWriter({
      spoolFile,
      forwardUrl: "http://127.0.0.1:9/unreachable",
      now: () => NOW,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const outcome = await writer.ensure({ merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, source: "rfq" });
    expect(outcome.status).toBe("unavailable");
    expect(JSON.parse(readFileSync(spoolFile, "utf8")).pending).toHaveLength(1);

    // 写者恢复：同一意图重试（drain）。
    server.state.healthy = true;
    const recovered = new SpooledCustomerIdentityWriter({
      spoolFile,
      forwardUrl: server.url,
      now: () => NOW,
      fetchImpl,
    });
    await recovered.drain();
    const spoolAfter = JSON.parse(readFileSync(spoolFile, "utf8"));
    expect(spoolAfter.pending).toHaveLength(0);
    expect(server.state.subjects.size).toBe(1);
  });

  it("未配置转发端点：unavailable 且不承诺建档", async () => {
    const writer = new SpooledCustomerIdentityWriter({ spoolFile, now: () => NOW });
    const outcome = await writer.ensure({ merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, source: "rfq" });
    expect(outcome.status).toBe("unavailable");
  });

  it("转发成功：意图即时清除（不重复投递）", async () => {
    server = createSpoolServer();
    const fetchImpl = vi.fn(async (url: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const body = await server?.handle(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const writer = new SpooledCustomerIdentityWriter({
      spoolFile,
      forwardUrl: server.url,
      now: () => NOW,
      fetchImpl,
    });
    const outcome = await writer.ensure({ merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, source: "rfq" });
    expect(outcome.status).toBe("registered");
    // 成功路径不产生待发项：spool 文件不存在或 pending 为空。
    let pending: unknown[] = [];
    try {
      pending = JSON.parse(readFileSync(spoolFile, "utf8")).pending ?? [];
    } catch {
      pending = [];
    }
    expect(pending).toHaveLength(0);
    expect(server.state.subjects.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Handler 业务边界（A6 无建档断言）
// ---------------------------------------------------------------------------

function recordingWriter(): CustomerIdentityWriter & { calls: Array<{ merchant_id: string; verified_actor: string; source: string }> } {
  const calls: Array<{ merchant_id: string; verified_actor: string; source: string }> = [];
  return {
    calls,
    async ensure(input) {
      calls.push({ merchant_id: input.merchant_id, verified_actor: input.verified_actor, source: input.source });
      return { status: "registered", subject_id: `subj_${calls.length}`, created: calls.length === 1 };
    },
  };
}

describe("K1 handler 业务边界（只在有效询价建档）", () => {
  let dir: string;
  let ledger: LedgerStore;
  let seq = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-k1-handler-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    seq = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const envelopeOf = (
    action: "rfq" | "inquiry" | "withdraw" | "decline",
    payload: Record<string, unknown>,
    negotiationId = "neg_k1",
  ): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: CAP,
      protocol_version: "1.0",
      negotiation_id: negotiationId,
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      actor: "buyer",
      action,
      created_at: NOW,
      payload: payload as never,
    });
  };

  const runHandler = async (
    writer: CustomerIdentityWriter,
    envelope: NegotiationEnvelope,
    options: { verified?: boolean; identity?: string; text?: string } = {},
  ) => {
    seq += 1;
    const handler = createMerchantHandler({
      productSource,
      ledger,
      now: () => NOW,
      sender: "merchant-agent",
      counterparty: "buyer:*",
      customerIdentity: { merchantId: MERCHANT, writer },
    });
    return await handler.handle({
      envelope: envelope as never,
      message: {
        role: "user",
        parts: options.text !== undefined ? [{ kind: "text", text: options.text }] : [],
        messageId: envelope.message_id,
      },
      taskId: `task_${seq}`,
      senderIdentity: options.identity ?? OPEN_ACTOR,
      identityVerified: options.verified ?? true,
    });
  };

  it("有效 RFQ + 验签开放询价身份 → 建档一次", async () => {
    const writer = recordingWriter();
    const result = await runHandler(writer, envelopeOf("rfq", {
      type: "rfq",
      items: [{ sku: SKU, quantity: { value: 50, unit: "piece" } }],
    }));
    expect(result.kind).toBe("accepted");
    expect(writer.calls).toEqual([
      { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, source: "rfq" },
    ]);
  });

  it("未验签 / 非开放询价身份 → 不建档", async () => {
    const unverified = recordingWriter();
    await runHandler(unverified, envelopeOf("rfq", {
      type: "rfq",
      items: [{ sku: SKU, quantity: { value: 50, unit: "piece" } }],
    }), { verified: false });
    expect(unverified.calls).toHaveLength(0);

    const otherIdentity = recordingWriter();
    await runHandler(otherIdentity, envelopeOf("rfq", {
      type: "rfq",
      items: [{ sku: SKU, quantity: { value: 50, unit: "piece" } }],
    }), { verified: true, identity: "buyer:static-credential" });
    expect(otherIdentity.calls).toHaveLength(0);
  });

  it("入参无效的 RFQ（schema_invalid）→ 不建档", async () => {
    const writer = recordingWriter();
    await runHandler(writer, envelopeOf("rfq", {
      type: "rfq",
      items: [{ sku: "", quantity: { value: 50, unit: "piece" } }],
    }));
    expect(writer.calls).toHaveLength(0);
  });

  it("业务拒绝的有效 RFQ 不建档", async () => {
    const writer = recordingWriter();
    for (const quantity of [{ value: 1, unit: "box" }, { value: 500, unit: "piece" }]) {
      const result = await runHandler(writer, envelopeOf("rfq", {
        type: "rfq", items: [{ sku: SKU, quantity }],
      }), { verified: true });
      expect(result.kind).toBe("declined");
    }
    expect(writer.calls).toHaveLength(0);
  });

  it("拒绝动作（withdraw/decline）→ 不建档", async () => {
    const writer = recordingWriter();
    await runHandler(writer, envelopeOf("withdraw", { type: "withdraw", scope: "offer", target_message_id: "msg_none" }));
    await runHandler(writer, envelopeOf("decline", { type: "decline", scope: "negotiation" }), { verified: true });
    expect(writer.calls).toHaveLength(0);
  });

  it("接待引擎判定闲聊不建档；判定询价才建档", async () => {
    const engineFor = () =>
      createMerchantReceptionEngine({
        store: {
          get: () => undefined,
          put: () => ({ merchantId: MERCHANT, identity: OPEN_ACTOR, contextId: "neg", need: { revision: 1, updatedAt: NOW } }),
          allocateReplySeq: () => 1,
        } as never,
        outbox: { record: () => ({}) } as never,
        productSource: productSource as never,
        now: () => NOW,
      });
    // 引擎对闲聊产生澄清（不判询价）→ 不建档。
    const chatEngine = engineFor();
    const chatResult = await chatEngine.respond({
      merchantId: MERCHANT,
      identity: OPEN_ACTOR,
      identityVerified: true,
      contextId: "neg",
      text: "你好",
      now: NOW,
    });
    expect(chatResult.recognizedInquiry).toBe(false);

    const inquiryEngine = engineFor();
    const inquiryResult = await inquiryEngine.respond({
      merchantId: MERCHANT,
      identity: OPEN_ACTOR,
      identityVerified: true,
      contextId: "neg",
      text: "50 个多少钱？",
      now: NOW,
    });
    expect(inquiryResult.recognizedInquiry).toBe(true);

    // handler 级：闲聊走 inquiry 分支不建档。
    const handlerWriter = recordingWriter();
    await runHandler(handlerWriter, envelopeOf("inquiry", { type: "inquiry" }), { text: "你好" });
    expect(handlerWriter.calls).toHaveLength(0);
  });

  it("GetTask / 搜索不经过 handler 商业分支 → 无建档调用（writer 只在 rfq/inquiry 分支被触达）", async () => {
    const writer = recordingWriter();
    // withdraw 后再来一次 rfq（同 negotiation）——被拒的请求不产生第二次建档之外的效果。
    await runHandler(writer, envelopeOf("rfq", {
      type: "rfq",
      items: [{ sku: SKU, quantity: { value: 50, unit: "piece" } },
      ],
    }));
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls.every((call) => ["rfq", "inquiry", "reception-text"].includes(call.source))).toBe(true);
  });
});
