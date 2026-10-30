/**
 * watch 通知检测/渲染/投递。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NegotiationApprovalRecord } from "../src/a2a/server/negotiation-approvals.js";
import type { NegotiationOwnerListViewItem } from "../src/merchant/negotiation-observer.js";
import type { NegotiationOps } from "../src/merchant/negotiation-ops.js";
import { detectNotifications } from "../src/merchant/watch/detect.js";
import { WecomWebhookChannel } from "../src/merchant/watch/notify.js";
import { MerchantWatchService } from "../src/merchant/watch/service.js";
import { emptyWatchState, loadWatchState, watchStatePath } from "../src/merchant/watch/state.js";

const NOW = new Date("2026-10-30T03:00:00Z");

const approval = (overrides: Partial<NegotiationApprovalRecord> = {}): NegotiationApprovalRecord => ({
  approval_id: "nap_001",
  negotiation_id: "neg_001",
  sku: "SKU-001",
  currency: "CNY",
  quantity: 10,
  buyer_offer_minor: 70_000,
  public_bound_minor: 80_750,
  floor_minor: 81_000,
  status: "pending",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  ...overrides,
});

const row = (overrides: Partial<NegotiationOwnerListViewItem> = {}): NegotiationOwnerListViewItem => ({
  negotiation_id: "neg_001",
  phase: "OFFER_OPEN",
  last_action: "counter_offer",
  sku: "SKU-001",
  quantity: 10,
  agreement: false,
  recorded_at: NOW.toISOString(),
  needs_attention: true,
  last_event_digest: "sha256:aaa",
  last_event_kind: "message_received",
  last_inbound_action: "counter_offer",
  ...overrides,
});

describe("watch detect", () => {
  it("首次运行不回放历史磋商，但现存 pending 审批会通知；企微文本不含底价", () => {
    const state = emptyWatchState(NOW.toISOString());
    const { notifications, next } = detectNotifications(
      state,
      { negotiations: [row()], total: 1, approvals: [approval()] },
      { channels: ["wecom", "weixin"], now: NOW },
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.texts.wecom).toContain("买家还价 ¥700.00");
    expect(notifications[0]!.texts.wecom).not.toContain("私有底价");
    expect(notifications[0]!.texts.weixin).toContain("私有底价 ¥810.00");
    expect(next.initialized_at).toBe(NOW.toISOString());
    expect(next.negotiations["neg_001"]?.last_event_digest).toBe("sha256:aaa");
  });

  it("新买家等待回应只通知一次；达成协议再通知一次", () => {
    const first = detectNotifications(
      emptyWatchState(NOW.toISOString()),
      { negotiations: [row()], total: 1, approvals: [] },
      { channels: ["wecom"], now: NOW },
    );
    const second = detectNotifications(
      first.next,
      { negotiations: [row({ last_event_digest: "sha256:bbb" })], total: 1, approvals: [] },
      { channels: ["wecom"], now: new Date(NOW.getTime() + 60_000) },
    );
    expect(second.notifications).toHaveLength(1);
    expect(second.notifications[0]!.texts.wecom).toContain("买家等待回应");

    const third = detectNotifications(
      second.next,
      {
        negotiations: [row({ last_event_digest: "sha256:ccc", agreement: true, needs_attention: false })],
        total: 1,
        approvals: [],
      },
      { channels: ["wecom"], now: new Date(NOW.getTime() + 120_000) },
    );
    expect(third.notifications[0]!.texts.wecom).toContain("达成非绑定协议");

    const fourth = detectNotifications(
      third.next,
      {
        negotiations: [row({ last_event_digest: "sha256:ccc", agreement: true, needs_attention: false })],
        total: 1,
        approvals: [],
      },
      { channels: ["wecom"], now: new Date(NOW.getTime() + 180_000) },
    );
    expect(fourth.notifications).toHaveLength(0);
  });

  it("同一 (negotiation, sku) 的 pending 通知 10 分钟内冷却", () => {
    const first = detectNotifications(
      emptyWatchState(NOW.toISOString()),
      { negotiations: [row()], total: 1, approvals: [approval()] },
      { channels: ["wecom"], now: NOW },
    );
    const again = detectNotifications(
      first.next,
      {
        negotiations: [row()],
        total: 1,
        approvals: [approval({ approval_id: "nap_002", updated_at: new Date(NOW.getTime() + 60_000).toISOString() })],
      },
      { channels: ["wecom"], now: new Date(NOW.getTime() + 60_000) },
    );
    expect(again.notifications).toHaveLength(0);
  });
});

describe("wecom channel", () => {
  it("拒绝非白名单主机；发送成功解析 errcode", async () => {
    expect(() => new WecomWebhookChannel("https://evil.example/hook")).toThrow(/白名单/);
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: unknown) =>
        new Response('{"errcode":0,"errmsg":"ok"}', { status: 200 }),
    );
    const channel = new WecomWebhookChannel("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await channel.send("hello");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ msgtype: "text", text: { content: "hello" } });
  });
});

describe("watch service", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("投递失败进入持久化队列，随后重试成功", async () => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-watch-"));
    let attempts = 0;
    const sent: string[] = [];
    const channel = {
      name: "wecom",
      async send(text: string) {
        attempts += 1;
        if (attempts === 1) throw new Error("network");
        sent.push(text);
      },
    };
    const ops = {
      snapshot: () => ({ negotiations: [row()], total: 1, approvals: [approval()] }),
    } as unknown as NegotiationOps;
    const service = new MerchantWatchService({
      dataDir: dir,
      ops,
      channels: [channel],
      intervalMs: 60_000,
      now: () => NOW,
      log: () => undefined,
    });
    service.start();
    await service.tick();
    service.stop();
    const state = loadWatchState(watchStatePath(dir), NOW.toISOString());
    expect(state.queue).toHaveLength(1);
    expect(sent).toHaveLength(0);

    const later = new MerchantWatchService({
      dataDir: dir,
      ops,
      channels: [channel],
      intervalMs: 60_000,
      now: () => new Date(Date.parse(state.queue[0]!.next_at) + 1_000),
      log: () => undefined,
    });
    later.start();
    await later.tick();
    later.stop();
    expect(sent).toHaveLength(1);
    expect(loadWatchState(watchStatePath(dir), NOW.toISOString()).queue).toHaveLength(0);
    expect(readFileSync(watchStatePath(dir), "utf8")).not.toContain("bot_token");
  });
});
