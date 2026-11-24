/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { rankOwnerInquiries, WeixinOwnerConversation, type OwnerInquiry, type WeixinOwnerConversationOptions } from "../src/merchant/weixin-owner-conversation.js";
import { createOwnerA2aInquirySource, createWorkbenchWeixinOwnerOptions } from "../src/merchant/weixin-owner-source.js";
import type { InboundMessage } from "../src/weixin/types.js";
import type { OwnerAgentDecision, WeixinOwnerAgent } from "../src/merchant/weixin-owner-agent.js";
import { ownerInventorySku, type OwnerInventoryObservation } from "../src/merchant/weixin-owner-inventory.js";

const scope = "fixture-key";
const account = "fixture-bound-account";
const principal = "fixture-owner";
const question = "今天哪三笔询价最该跟？";
const askDraft = "给第二笔起草回复，先给我看";
const signal = new AbortController().signal;

function message(id: string, text: string): InboundMessage {
  return { account, from_user_id: account, message_id: id, context_token: "test-context", text, direct_text: true };
}

describe("persisted owner follow-up", () => {
  let dir: string;
  let dbPath: string;
  let data: OwnerInquiry[];
  let revision: string | undefined;
  let store: WeixinOwnerConversation | undefined;
  let now: number;

  function open(compose?: WeixinOwnerConversationOptions["compose"], inventory?: WeixinOwnerConversationOptions["inventory"],
    delivery: Pick<WeixinOwnerConversationOptions, "replyToOwner" | "agent"> = {}) {
    const result = new WeixinOwnerConversation(dbPath, {
      enabled: true, workbenchOrigin: "https://merchant.example", ownerRevision: (p) => p === principal ? revision : undefined,
      source: { list: () => data, get: (id) => data.find((item) => item.id === id) },
      ...(compose === undefined ? {} : { compose }),
      ...(inventory === undefined ? {} : { inventory }),
      ...delivery,
    }, () => now);
    store = result;
    return result;
  }

  function admit(c: WeixinOwnerConversation, ...messages: InboundMessage[]) {
    c.admit(scope, account, messages, c.consent(scope));
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kiwi-weixin-owner-"));
    dbPath = path.join(dir, "owner.sqlite");
    now = Date.UTC(2026, 10, 23, 9);
    data = [
      { id: "inquiry-a", version: "v1", dueAt: now + 1000, receivedAt: now - 700, sku: "SKU-A" },
      { id: "inquiry-b", version: "v1", receivedAt: now - 200, sku: "SKU-B" },
      { id: "inquiry-c", version: "v1", dueAt: now - 1, receivedAt: now - 500, sku: "SKU-C" },
    ];
    revision = "owner-credentials-v1";
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("rank is deterministic and uses a stable ID on ties", () => {
    const z = { ...data[0]!, id: "inquiry-z" };
    expect(rankOwnerInquiries([z, ...data], now).map((row) => row.id)).toEqual(["inquiry-c", "inquiry-a", "inquiry-z"]);
  });

  it("keeps real owner results local and uses explicit references from Workbench previews after restart", async () => {
    const a = open();
    a.bind(principal, scope);
    admit(a, message("1", question));
    const send = vi.fn(async () => {});
    await a.process(scope, signal, send);
    expect(send).not.toHaveBeenCalled();
    await a.prepare(scope, signal);
    const preview = a.status(principal, scope).preview as string;
    expect(preview).toContain("SKU-C");
    expect(preview.indexOf("SKU-C")).toBeLessThan(preview.indexOf("SKU-A"));
    const ref = preview.match(/L-[0-9A-F]{8}/)?.[0];
    expect(ref).toBeDefined();
    expect(a.status("someone-else", scope).preview).toBeNull();
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    a.close();
    const b = open();
    admit(b, message("1", question), message("2", `给 ${ref} 的第二笔起草回复`), message("2", `给 ${ref} 的第二笔起草回复`));
    await b.prepare(scope, signal);
    const [draft] = b.listDrafts(principal);
    expect(b.listDrafts(principal)).toHaveLength(1);
    expect(draft?.inquiry).toBe("inquiry-a");
    const offlineSend = vi.fn(async () => {});
    await b.process(scope, signal, offlineSend);
    expect(offlineSend).not.toHaveBeenCalled();
    expect(b.draft(principal, draft!.id)).toMatchObject({ current: true, publication: "not_configured" });
    expect(b.edit(principal, draft!.id, 1, "商品需求正在核对，谢谢。特别需求请补充。" )).toMatchObject({ version: 2 });
    expect(() => b.edit(principal, draft!.id, 1, "旧版编辑")).toThrow(/版本|变化/);
    expect(() => b.draft("someone-else", draft!.id)).toThrow();
    data = [];
    expect(b.draft(principal, draft!.id).current).toBe(false);
    expect(() => b.edit(principal, draft!.id, 2, "事实已变化")).toThrow(/变化/);
  });

  it("only accepts paired private text with an ID, and clears old consent without losing dedupe", async () => {
    const a = open();
    a.bind(principal, scope);
    const previousConsent = a.consent(scope);
    admit(a, { ...message("1", question), direct_text: undefined } as unknown as InboundMessage,
      { ...message("2", question), from_user_id: "other" }, message("", question));
    await a.prepare(scope, signal);
    expect(a.status(principal, scope).preview).toBeNull();
    admit(a, message("3", question));
    await a.prepare(scope, signal);
    expect(a.status(principal, scope).preview).not.toBeNull();
    a.clear(principal, scope);
    a.admit(scope, account, [message("4", question)], previousConsent);
    admit(a, message("3", question));
    await a.prepare(scope, signal);
    expect(a.status(principal, scope).preview).toBeNull();
  });

  it("does not use a short list reference that matches two saved previews", async () => {
    const a = open();
    a.bind(principal, scope);
    admit(a, message("first", question), message("second", question));
    await a.prepare(scope, signal);
    const second = new DatabaseSync(dbPath);
    try {
      second.exec(`UPDATE owner_turn SET list=json_set(list, '$.ref', 'L-0123ABCD') WHERE list IS NOT NULL`);
    } finally { second.close(); }
    admit(a, message("pick", "给 L-0123ABCD 的第一笔起草回复"));
    await a.prepare(scope, signal);
    expect(a.status(principal, scope).preview).toContain("未能确认");
    expect(a.listDrafts(principal)).toHaveLength(0);
  });

  it("validates the batch before any cursor advancement can be acknowledged", () => {
    const a = open();
    a.bind(principal, scope);
    const second = new DatabaseSync(dbPath);
    try {
      second.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON owner_turn WHEN NEW.text = 'fixture batch failure'
        BEGIN SELECT RAISE(ABORT, 'fixture'); END;`);
      expect(() => admit(a, message("1", question), message("2", "fixture batch failure"))).toThrow();
      expect(second.prepare("SELECT COUNT(*) count FROM owner_turn").get()).toMatchObject({ count: 0 });
    } finally { second.close(); }
  });

  it("reports the pending count but lists only the top three and can repeat it in natural language", async () => {
    data.push({ id: "inquiry-d", version: "v1", receivedAt: now - 100 });
    const c = open(undefined, undefined, { replyToOwner: true });
    c.bind(principal, scope);
    admit(c, message("list", question), message("repeat", "刚才聊到哪里？"));
    const send = vi.fn(async (_input: { text: string; context: string }) => {});
    await c.process(scope, signal, send);
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0]?.[0].text;
    expect(first).toContain("有 4 笔待跟进询价，先列优先的 3 笔");
    expect(first?.match(/^\d+\. /gm)).toHaveLength(3);
    expect(send.mock.calls[1]?.[0].text).toBe(first);
  });

  it("does not guess when a newer list send is unknown or automatically resend it on restart", async () => {
    const a = open(undefined, undefined, { replyToOwner: true });
    a.bind(principal, scope);
    const send = vi.fn(async (_input: { text: string; context: string }) => {});
    admit(a, message("1", question));
    await a.process(scope, signal, send);
    admit(a, message("2", question));
    await expect(a.process(scope, signal, async () => { throw new Error("timeout after request"); })).rejects.toThrow();
    expect(a.status(principal, scope).unknown_count).toBe(1);
    a.close();
    const b = open(undefined, undefined, { replyToOwner: true });
    admit(b, message("2", question), message("3", askDraft));
    await b.process(scope, signal, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ text: expect.stringContaining("未能确认") });
    expect(send.mock.calls.at(-1)?.[0].text).not.toMatch(/L-[0-9A-F]{8}/);
    expect(b.listDrafts(principal)).toHaveLength(0);
  });

  it("keeps scheduling and private preferences separate from formal policy and outbound", async () => {
    const a = open();
    a.bind(principal, scope);
    expect(a.preference(principal)).toMatchObject({ version: 0, style: null });
    expect(a.setPreference(principal, 0, "concise")).toMatchObject({ version: 1, style: "concise" });
    expect(() => a.setPreference(principal, 0, "warm")).toThrow(/版本/);
    expect(a.setPreference(principal, 1, null)).toMatchObject({ version: 2, style: null });
    expect(() => a.preference("other-principal")).toThrow();
    admit(a, message("digest", "工作日下午五点，把待回复询价发给我"));
    await a.prepare(scope, signal);
    expect(a.status(principal, scope).rule_proposal).toMatchObject({ delivery: "workbench_only", prepare: {
      template: "unfinished_inquiry_digest", trigger_spec: { local_time: "17:00", day_filter: "weekdays" },
    } });
    admit(a, message("policy", "以后大额报价先找我"));
    await a.prepare(scope, signal);
    expect(a.status(principal, scope)).toMatchObject({ preview: expect.stringContaining("未更改任何政策"), rule_proposal: null });
  });

  it("only accepts exact stock queries and drops the result of an in-flight read after clear", async () => {
    expect(ownerInventorySku("查询库存：SKU-01？")).toBe("SKU-01");
    expect(ownerInventorySku("查库存 SKU-01 SKU-02")).toBeUndefined();
    expect(ownerInventorySku("查库存 https://example.com/item")).toBeUndefined();
    expect(ownerInventorySku("把 SKU-01 的库存改为 0")).toBeUndefined();
    let finish!: (observation: OwnerInventoryObservation) => void;
    const inventory = vi.fn((_sku: string) => new Promise<OwnerInventoryObservation>((resolve) => { finish = resolve; }));
    const a = open(undefined, inventory);
    a.bind(principal, scope);
    admit(a, message("inventory", "查库存 SKU-01"));
    const pending = a.prepare(scope, signal);
    expect(inventory).toHaveBeenCalledExactlyOnceWith("SKU-01");
    a.clear(principal, scope);
    finish({ sku: "SKU-01", stock: 0, listingPaused: false, observedAt: now });
    await pending;
    expect(a.status(principal, scope).preview).toBeNull();
  });

  it("does not read exact stock on the simulated outbound path", async () => {
    const inventory = vi.fn(async (sku: string) => ({ sku, stock: 12345, listingPaused: false, observedAt: now }));
    const a = open(undefined, inventory, { replyToOwner: true });
    a.bind(principal, scope);
    admit(a, message("inventory", "查库存 SKU-01"));
    const send = vi.fn(async (_input: { text: string; context: string }) => {});
    await a.process(scope, signal, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining("请在工作台查看") }));
    expect(send.mock.calls[0]?.[0].text).not.toContain("12345");
    expect(inventory).not.toHaveBeenCalled();
  });

  it("requires new consent when upgrading a preview and never sends a previously queued message", async () => {
    const preview = open();
    preview.bind(principal, scope);
    const oldConsent = preview.consent(scope);
    admit(preview, message("old", question));
    preview.close();
    const direct = open(undefined, undefined, { replyToOwner: true });
    const send = vi.fn(async (_input: { text: string; context: string }) => {});
    expect(direct.status(principal, scope)).toMatchObject({ delivery: "paired_owner", authorized: false });
    await direct.process(scope, signal, send);
    direct.bind(principal, scope);
    direct.admit(scope, account, [message("old-batch", question)], oldConsent);
    admit(direct, message("old", question), message("new", "你是谁？"));
    await direct.process(scope, signal, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining("Kiwi 商家智能体") }));
    expect(direct.listDrafts(principal)).toHaveLength(0);
  });

  it("drops queued replies on revoke and does not replay the in-flight reply into a new binding", async () => {
    let finish!: () => void;
    const send = vi.fn<(reply: { text: string; context: string }) => Promise<void>>();
    send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const c = open(undefined, undefined, { replyToOwner: true });
    c.bind(principal, scope);
    admit(c, message("1", question), message("2", askDraft));
    const first = c.process(scope, signal, send);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    c.revoke();
    finish();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
    expect(c.listDrafts(principal)).toHaveLength(0);
    c.bind(principal, scope);
    admit(c, message("2", askDraft), message("3", "刚才的清单再说一遍"));
    await c.process(scope, signal, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0].text).toContain("没有可复述的近期回复");
  });

  it("aborts the current model call on clear, drops its late result and starts with empty history", async () => {
    let release!: (value: OwnerAgentDecision) => void;
    let modelSignal: AbortSignal | undefined;
    const decide = vi.fn<Extract<WeixinOwnerAgent, { state: "configured" }>["decide"]>();
    decide.mockImplementationOnce((_turn, current) => {
      modelSignal = current;
      return new Promise((resolve) => { release = resolve; });
    }).mockResolvedValue({ kind: "reply", text: "新对话" });
    const c = open(undefined, undefined, { replyToOwner: true,
      agent: { state: "configured", provider: "fixture", model: "fixture", endpoint: "https://model.example", consent: "a".repeat(64), decide } });
    c.bind(principal, scope);
    const send = vi.fn(async () => {});
    admit(c, message("old", "这是旧对话"));
    const pending = c.process(scope, signal, send);
    expect(modelSignal?.aborted).toBe(false);
    c.clear(principal, scope);
    expect(modelSignal?.aborted).toBe(true);
    release({ kind: "reply", text: "不应该发送" });
    await pending;
    expect(send).not.toHaveBeenCalled();
    admit(c, message("new", "这是新对话"));
    await c.process(scope, signal, send);
    expect(decide.mock.calls[1]?.[0].history).toEqual([]);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "新对话" }));
  });

  it("does not repeat a reserved model attempt after a worker restart", async () => {
    const decide = vi.fn<Extract<WeixinOwnerAgent, { state: "configured" }>["decide"]>();
    const delivery = { replyToOwner: true, agent: { state: "configured" as const,
      provider: "fixture", model: "fixture", endpoint: "https://model.example", consent: "a".repeat(64), decide } };
    const c = open(undefined, undefined, delivery);
    c.bind(principal, scope);
    admit(c, message("interrupted", "你好"));
    const restart = new AbortController();
    decide.mockImplementationOnce(async () => {
      restart.abort();
      throw new Error("worker interrupted");
    });
    const send = vi.fn(async () => {});
    await c.process(scope, restart.signal, send);
    c.close();
    const reopened = open(undefined, undefined, delivery);
    await reopened.process(scope, signal, send);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining("未自动重试") }));
  });

  it("fences a late composer after owner credential rotation and a concurrent clear", async () => {
    let release: ((s: string) => void) | undefined;
    const c = open(() => new Promise((resolve) => { release = resolve; }));
    c.bind(principal, scope);
    admit(c, message("1", question));
    await c.prepare(scope, signal);
    const preview = c.status(principal, scope).preview;
    const ref = typeof preview === "string" ? preview.match(/L-[0-9A-F]{8}/)?.[0] : undefined;
    expect(ref).toBeDefined();
    admit(c, message("2", `给 ${ref} 的第二笔起草回复`));
    const processing = c.prepare(scope, signal);
    expect(release).toBeTypeOf("function");
    c.clear(principal, scope);
    revision = "rotated";
    release!("fixture late reply");
    await processing;
    expect(c.status(principal, scope).authorized).toBe(false);
    expect(c.listDrafts(principal)).toHaveLength(0);
  });
});

it("keeps real owner replies off by default and enables them only through the separate switch", () => {
  const input = { flag: "1", dataDir: "/unused", adminDir: "/unused", merchantId: "fixture", agentId: "fixture-agent",
    origin: "https://merchant.example" };
  expect(createWorkbenchWeixinOwnerOptions(input)).toMatchObject({ enabled: true, replyToOwner: false });
  const disabled = createWorkbenchWeixinOwnerOptions({ ...input, flag: undefined, replyFlag: "true" });
  expect(disabled).toMatchObject({ enabled: false, replyToOwner: false });
  const direct = createWorkbenchWeixinOwnerOptions({ ...input, flag: undefined, replyFlag: "1", origin: undefined });
  expect(direct).toMatchObject({ enabled: true, replyToOwner: true });
});

describe("A2A inquiry source", () => {
  it("requires the local merchant binding, skips already answered and avoids raw buyer payload", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-weixin-ledger-"));
    const data = createOwnerA2aInquirySource(dir, "agent-local");
    const ledger = new LedgerStore({ dir: path.join(dir, "a2a") });
    const cap = { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" };
    const at = "2026-11-23T00:00:00.000Z";
    try {
      for (const [id, local] of [["pending", "agent-local"], ["foreign", "agent-other"], ["answered", "agent-local"]] as const) {
        expect(ledger.ensureCounterpartyBinding({ negotiationId: id, actor: "buyer", localIdentity: local, senderIdentity: "buyer-1" })).toBe("bound");
        if (id === "answered") ledger.append({
          event_kind: "message_sent", negotiation_id: id, message_id: "out", in_reply_to: "in",
          identity: { sender_identity: local, counterparty_identity: "buyer-1", actor: "merchant" },
          capability: cap, outcome: { kind: "ok" }, occurred_at: at,
        });
        ledger.appendSegmented({
          event_kind: "message_received", negotiation_id: id, message_id: "in",
          identity: { sender_identity: "buyer-1", counterparty_identity: "buyer-1", actor: "buyer" },
          capability: cap, outcome: { kind: "ok" }, occurred_at: at,
          wire_payload: { action: "rfq", public_message: "buyer free text", payload: { items: [{ sku: "SKU-1", quantity: { value: 2 } }] } },
        });
      }
      expect(data.list()).toEqual([expect.objectContaining({ id: "pending", sku: "SKU-1", quantity: 2 })]);
      expect(JSON.stringify(data.get("pending"))).not.toContain("buyer free text");
      expect(data.get("foreign")).toBeUndefined();
      expect(data.get("answered")).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
