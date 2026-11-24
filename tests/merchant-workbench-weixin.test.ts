import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import { createMerchantManagementApiHandler } from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import type { MerchantRole } from "../src/merchant/application/actor.js";
import { MerchantWeixinChannel } from "../src/merchant/weixin-channel.js";
import type { WeixinOwnerConversationOptions } from "../src/merchant/weixin-owner-conversation.js";
import { createOwnerInventoryReader } from "../src/merchant/weixin-owner-inventory.js";
import { MerchantClientError, type ExactMerchantProduct } from "../src/agent/merchant/types.js";
import { IlinkClient } from "../src/weixin/ilink-client.js";
import { WeixinError, type BotCredentials, type QrcodeStatus } from "../src/weixin/types.js";

const MERCHANT = "workbench-weixin-merchant";
const ORIGIN = "https://merchant.example";
const ENDPOINT = "/merchant/api/v1/channels/weixin";
const credentials: BotCredentials = {
  ilink_bot_id: "fixture-bot", ilink_user_id: "fixture-paired-user", bot_token: "fixture-bot-secret",
  base_url: "https://ilinkai.weixin.qq.com", saved_at: "",
};
const qr = { qrcode: "fixture-poll-token", qrcode_img_content: "https://weixin.qq.com/fixture-scan" };
const confirmed: QrcodeStatus = { state: "confirmed", credentials };

describe("merchant Workbench Weixin channel", () => {
  let dir: string;
  let db: DatabaseSync;
  let sessions: MerchantAdminSessions;
  let channel: MerchantWeixinChannel;
  let server: ReturnType<typeof createServer>;
  let url: string;
  let now: number;
  let generation: number;
  const getBotQrcode = vi.fn<IlinkClient["getBotQrcode"]>();
  const getQrcodeStatus = vi.fn<IlinkClient["getQrcodeStatus"]>();
  const getUpdates = vi.fn<IlinkClient["getUpdates"]>();
  const sendMessage = vi.fn<IlinkClient["sendMessage"]>();
  const setBaseUrl = vi.fn<IlinkClient["setBaseUrl"]>();

  function newChannel(conversation?: WeixinOwnerConversationOptions) {
    return new MerchantWeixinChannel({
      dataDir: dir, merchantId: MERCHANT, now: () => now,
      ...(conversation === undefined ? {} : { conversation }),
      client: () => ({ getBotQrcode, getQrcodeStatus, getUpdates, sendMessage, setBaseUrl }),
    });
  }

  async function startServer() {
    server = createServer(createMerchantManagementApiHandler({
      weixinChannel: channel,
      merchantId: MERCHANT, generation: () => generation, runtimeVersion: "test", sessions, allowedOrigins: [ORIGIN],
      listPending: () => [], mintCandidateConfirmation: () => "unused", executeDecision: async () => {},
      operations: new MerchantManagementOperationStore({ db }), serviceState: new MutableServiceState("OPERATING"),
      drafts: new MerchantImportDraftStore({ db }), readiness: async () => ({ ready: true, checks: {} }),
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected HTTP address");
    url = `http://127.0.0.1:${address.port}`;
  }

  async function stopServer() {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "kiwi-workbench-weixin-"));
    db = new DatabaseSync(":memory:");
    sessions = new MerchantAdminSessions({ db });
    now = Date.now();
    generation = 1;
    getBotQrcode.mockReset().mockResolvedValue(qr);
    getQrcodeStatus.mockReset().mockResolvedValue({ state: "wait" });
    getUpdates.mockReset().mockResolvedValue({ messages: [], next_sync_buf: "", longpoll_timeout_ms: 35_000 });
    sendMessage.mockReset().mockResolvedValue(undefined);
    setBaseUrl.mockReset();
    channel = newChannel();
    await startServer();
  });

  afterEach(async () => {
    await channel.close();
    await stopServer();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function login(role: MerchantRole = "owner", merchantId = MERCHANT) {
    const { sessionId } = sessions.createSession({ principalId: "fixture-owner", merchantId, role });
    const cookie = `${ADMIN_SESSION_COOKIE}=${sessionId}`;
    const session = await fetch(url + "/merchant/api/session", { headers: { cookie } });
    const info = await session.json() as { csrf_token: string };
    return { cookie, csrf: info.csrf_token };
  }

  async function request(action: string, auth?: Awaited<ReturnType<typeof login>>, body: Record<string, unknown> = {}, origin = ORIGIN) {
    return fetch(url + ENDPOINT + action, {
      method: action ? "POST" : "GET",
      headers: {
        origin, "content-type": "application/json",
        ...(auth ? { cookie: auth.cookie, "x-csrf-token": auth.csrf } : {}),
      },
      ...(action ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function begin(auth: Awaited<ReturnType<typeof login>>) {
    const response = await request("/begin", auth);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const attempt = await response.json() as { attempt_id: string; qr_rows: string[]; status: string };
    expect(attempt.qr_rows[0]).toMatch(/^[01]+$/);
    expect(attempt.qr_rows).toHaveLength(attempt.qr_rows[0]!.length);
    expect(JSON.stringify(attempt)).not.toContain(qr.qrcode);
    return { attempt_id: attempt.attempt_id };
  }

  function credentialsPath() {
    return path.join(dir, "weixin-workbench", createHash("sha256").update(MERCHANT).digest("hex"), "credentials.json");
  }

  it("keeps QR operations owner-only, merchant-scoped, session-bound, and CSRF/Origin guarded", async () => {
    expect((await request("")).status).toBe(401);
    const owner = await login();
    const operator = await login("operator");
    const otherMerchant = await login("owner", "other-merchant");
    expect((await request("/begin", operator)).status).toBe(403);
    expect((await request("/begin", { ...owner, csrf: "" })).status).toBe(403);
    expect((await request("/begin", owner, {}, "https://other.example")).status).toBe(403);
    expect((await request("/begin", otherMerchant)).status).toBe(404);
    expect((await request("/begin", owner, { merchant_id: "other-merchant" })).status).toBe(422);
    expect(getBotQrcode).not.toHaveBeenCalled();

    const attempt = await begin(owner);
    const secondOwner = await login();
    expect((await request("/begin", secondOwner)).status).toBe(409);
    expect((await request("/poll", secondOwner, attempt)).status).toBe(404);
    expect((await request("/cancel", secondOwner, attempt)).status).toBe(404);
    expect(getQrcodeStatus).not.toHaveBeenCalled();
    expect((await request("/cancel", owner, attempt)).status).toBe(200);
    expect((await request("/poll", owner, attempt)).status).toBe(404);
  });

  it("waits for phone confirmation, accepts a pairing code, and only replies to the paired user's /ping", async () => {
    const owner = await login();
    const attempt = await begin(owner);
    getQrcodeStatus.mockResolvedValueOnce({ state: "scaned_but_redirect", baseUrl: "https://region.qq.com" })
      .mockResolvedValueOnce({ state: "need_verifycode" }).mockResolvedValueOnce(confirmed);
    expect(await (await request("/poll", owner, attempt)).json()).toEqual({ status: "scanned" });
    expect(setBaseUrl).toHaveBeenCalledWith("https://region.qq.com");
    expect(existsSync(credentialsPath())).toBe(false);
    now += 2_000;
    expect(await (await request("/poll", owner, attempt)).json()).toEqual({ status: "verification_required" });
    expect(await (await request("/poll", owner, attempt)).json()).toEqual({ status: "verification_required" });
    expect(getQrcodeStatus).toHaveBeenCalledTimes(2);
    expect(existsSync(credentialsPath())).toBe(false);
    now += 2_000;
    expect((await request("/poll", owner, { ...attempt, verify_code: "not-digits" })).status).toBe(422);
    const ping = { account: "fixture-paired-user", from_user_id: "fixture-paired-user", text: "/ping", message_id: "1", context_token: "fixture-context" };
    getUpdates.mockResolvedValueOnce({
      messages: [{ ...ping, from_user_id: "other-user" }, { ...ping, text: "/approve" }, ping],
      next_sync_buf: "fixture-cursor", longpoll_timeout_ms: 35_000,
    });
    expect(await (await request("/poll", owner, { ...attempt, verify_code: "018765" })).json()).toEqual({ status: "confirmed" });
    expect(getQrcodeStatus).toHaveBeenLastCalledWith(qr.qrcode, expect.objectContaining({ verifyCode: "018765" }));
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    const status = await request("", owner);
    expect(status.headers.get("cache-control")).toContain("no-store");
    expect(await status.json()).toEqual({ status: "connected", configured: true });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to_user_id: credentials.ilink_user_id, context_token: ping.context_token }), credentials, expect.any(AbortSignal),
    );
    expect((await request("/begin", owner)).status).toBe(409);
    expect(await (await request("/disconnect", owner)).json()).toEqual({ status: "disconnected" });
    expect(existsSync(credentialsPath())).toBe(false);
    expect((await begin(owner)).attempt_id).not.toBe(attempt.attempt_id);
  });

  it.each(["cancelled", "expired", "generation changed", "session revoked"])("does not persist a late confirmation after %s", async (reason) => {
    const owner = await login();
    const attempt = await begin(owner);
    let resolveStatus!: (result: QrcodeStatus) => void;
    getQrcodeStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    const polling = request("/poll", owner, attempt);
    await vi.waitFor(() => expect(resolveStatus).toBeTypeOf("function"));
    if (reason === "cancelled") expect((await request("/cancel", owner, attempt)).status).toBe(200);
    else if (reason === "expired") now += 9 * 60_000;
    else if (reason === "generation changed") generation++;
    else sessions.revokeMerchantSessions(MERCHANT);
    resolveStatus(confirmed);
    expect(await polling.then((response) => response.status)).toBeGreaterThanOrEqual(400);
    expect(existsSync(credentialsPath())).toBe(false);
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it("accepts owner text into a private Workbench draft without sending a business reply to WeChat", async () => {
    await stopServer();
    await channel.close();
    const inquiry = { id: "fixture-inquiry", version: "v1", receivedAt: now - 1000, sku: "SKU-TEST" };
    channel = newChannel({
      enabled: true,
      ownerRevision: (id) => id === "fixture-owner" ? "fixture-revision" : undefined,
      workbenchOrigin: ORIGIN,
      source: { list: () => [inquiry], get: (id) => id === inquiry.id ? inquiry : undefined },
    });
    await startServer();
    const owner = await login();
    const attempt = await begin(owner);
    const incoming = (id: string, text: string) => ({
      account: credentials.ilink_user_id!, from_user_id: credentials.ilink_user_id!, direct_text: true as const,
      text, message_id: id, context_token: "fixture-reply-context",
    });
    getQrcodeStatus.mockResolvedValueOnce(confirmed);
    getUpdates.mockResolvedValueOnce({ messages: [incoming("m1", "今天哪三笔询价最该跟？")], next_sync_buf: "c1", longpoll_timeout_ms: 35000 });
    expect((await request("/poll", owner, attempt)).status).toBe(200);
    const status = await vi.waitFor(async () => {
      const info = await (await request("", owner)).json() as { conversation: { preview: string } };
      expect(info.conversation.preview).toContain("fixture-inquiry");
      return info;
    });
    const ref = status.conversation.preview.match(/L-[\dA-F]{8}/)?.[0];
    expect(ref).toBeDefined();
    const draftMessage = incoming("m2", `给 ${ref} 的第一笔起草回复，先给我看`);
    getUpdates.mockResolvedValueOnce({ messages: [draftMessage, draftMessage], next_sync_buf: "c2", longpoll_timeout_ms: 35000 });
    const get = (suffix: string, auth: typeof owner) => fetch(url + ENDPOINT + suffix, { headers: { cookie: auth.cookie } });
    const id = await vi.waitFor(async () => {
      const { items } = await (await get("/reply-drafts", owner)).json() as { items: { id: string; inquiry: string }[] };
      expect(items).toHaveLength(1);
      expect(items[0]?.inquiry).toBe(inquiry.id);
      return items[0]!.id;
    }, { timeout: 3000 });
    const draftPath = "/reply-drafts/" + id;
    expect(status).toMatchObject({ operations_available: false });
    const preferencePath = "/followup-preference";
    expect((await get(preferencePath, await login("operator"))).status).toBe(403);
    expect((await request(preferencePath, { ...owner, csrf: "" }, { version: 0, style: "warm" })).status).toBe(403);
    expect(await (await request(preferencePath, owner, { version: 0, style: "warm" })).json()).toMatchObject({ version: 1, style: "warm" });
    expect((await request(preferencePath, owner, { version: 0, style: null })).status).toBe(409);
    expect(await (await request(preferencePath, owner, { version: 1, style: null })).json()).toMatchObject({ version: 2, style: null });
    expect(await (await get(draftPath, owner)).json()).toMatchObject({ publication: "not_configured", version: 1 });
    expect((await get(draftPath, await login("operator"))).status).toBe(403);
    expect((await request(draftPath, { ...owner, csrf: "" }, { version: 1, body: "fixture edit" })).status).toBe(403);
    expect(await (await request(draftPath, owner, { version: 1, body: "fixture edit" })).json()).toMatchObject({ body: "fixture edit", version: 2 });
    expect((await request(draftPath, owner, { version: 1, body: "stale edit" })).status).toBe(409);
    expect((await request("/clear-conversation", owner)).status).toBe(200);
    expect(await (await request("", owner)).json()).toMatchObject({ conversation: { preview: null } });
    expect((await get(draftPath, owner)).status).toBe(200);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("delivers the first owner reply through the real client against an authenticated loopback iLink fixture", async () => {
    const replies: unknown[] = [];
    const iLink = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      let raw = "";
      for await (const part of req) raw += String(part);
      const route = req.url?.split("?")[0];
      if (route === "/ilink/bot/get_bot_qrcode") {
        res.end(JSON.stringify(qr));
        return;
      }
      if (route === "/ilink/bot/get_qrcode_status") {
        res.end(JSON.stringify({ status: "confirmed", ilink_bot_id: credentials.ilink_bot_id,
          ilink_user_id: credentials.ilink_user_id, bot_token: credentials.bot_token }));
        return;
      }
      if (req.headers.authorizationtype !== "ilink_bot_token" || req.headers.authorization !== `Bearer ${credentials.bot_token}` ||
          typeof req.headers["x-wechat-uin"] !== "string") {
        res.end(JSON.stringify({ ret: -14 }));
        return;
      }
      if (route === "/ilink/bot/getupdates") {
        const first = JSON.parse(raw).get_updates_buf === "";
        const inbound = JSON.stringify({ from_user_id: credentials.ilink_user_id, to_user_id: credentials.ilink_bot_id,
          message_type: 1, context_token: "fixture-first-reply-context",
          item_list: [{ type: 1, text_item: { text: "今天有什么要跟进的？" } }],
        });
        // 按 iLink 的原始 JSON 数字编码，不能让测试夹具先对 uint64 舍入。
        const msgs = first ? `[{"message_id":9007199254740993,${inbound.slice(1)}]` : "[]";
        res.end(`{"ret":0,"get_updates_buf":"fixture-cursor","msgs":${msgs}}`);
      } else if (route === "/ilink/bot/sendmessage") {
        replies.push(JSON.parse(raw).msg);
        res.end('{"ret":0}');
      } else {
        res.writeHead(404).end('{}');
      }
    });
    await new Promise<void>((resolve) => iLink.listen(0, "127.0.0.1", resolve));
    try {
      const address = iLink.address();
      if (!address || typeof address === "string") throw new Error("expected HTTP fixture address");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      await channel.close();
      await stopServer();
      channel = new MerchantWeixinChannel({ dataDir: dir, merchantId: MERCHANT, client: () => new IlinkClient({ baseUrl }),
        conversation: { enabled: true, replyToOwner: true, workbenchOrigin: ORIGIN,
          ownerRevision: (principal) => principal === "fixture-owner" ? "fixture-revision" : undefined,
          source: { list: () => [{ id: "one", version: "v1", receivedAt: now - 100 },
            { id: "two", version: "v1", receivedAt: now }], get: () => undefined } } });
      await startServer();
      const owner = await login();
      expect((await request("/poll", owner, await begin(owner))).status).toBe(200);
      await vi.waitFor(async () => {
        expect(await (await request("", owner)).json()).toMatchObject({ status: "connected",
          conversation: { authorized: true, last_result: "accepted" } });
      });
      expect(replies).toEqual([expect.objectContaining({ to_user_id: credentials.ilink_user_id,
        context_token: "fixture-first-reply-context", item_list: [{ type: 1, text_item: { text: expect.stringContaining("有 2 笔待跟进询价") } }] })]);
    } finally {
      await channel.close();
      iLink.closeAllConnections();
      await new Promise<void>((resolve) => iLink.close(() => resolve()));
    }
  });

  it("bridges paired WeChat messages to the merchant runtime across restart without any buyer action", async () => {
    await stopServer();
    await channel.close();
    const inquiries = [
      { id: "private-inquiry-first", version: "v1", receivedAt: now - 60_000, sku: "PRIVATE-SKU-ONE" },
      { id: "private-inquiry-second", version: "v2", receivedAt: now - 30_000, sku: "PRIVATE-SKU-TWO" },
    ];
    const config: WeixinOwnerConversationOptions = {
      enabled: true, replyToOwner: true, workbenchOrigin: ORIGIN,
      ownerRevision: (id) => id === "fixture-owner" ? "fixture-revision" : undefined,
      source: { list: () => inquiries, get: (id) => inquiries.find((item) => item.id === id) },
    };
    const incoming = (id: string, text: string) => ({
      account: credentials.ilink_user_id, from_user_id: credentials.ilink_user_id,
      direct_text: true as const, text, message_id: id, context_token: "context-" + id,
    });
    const list = incoming("list", "今天有什么要跟进的？");
    channel = newChannel(config);
    await startServer();
    const owner = await login();
    const attempt = await begin(owner);
    getQrcodeStatus.mockResolvedValueOnce(confirmed);
    getUpdates.mockResolvedValueOnce({ messages: [
      { ...incoming("foreign", "今天有什么要跟进的？"), from_user_id: "not-the-owner" },
      { ...incoming("non-direct", "你好"), direct_text: undefined } as unknown as ReturnType<typeof incoming>,
      incoming("", "你好"), incoming("slash", "/approve candidate"),
      incoming("greet", "你好"), list,
    ], next_sync_buf: "before-restart", longpoll_timeout_ms: 35_000 });
    expect((await request("/poll", owner, attempt)).status).toBe(200);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(sendMessage.mock.calls[0]?.[0].text).toContain("Kiwi 商家智能体");
    const firstList = sendMessage.mock.calls[1]?.[0].text;
    expect(firstList).toMatch(/有 2 笔待跟进询价/);
    expect(await (await request("", owner)).json()).toMatchObject({ conversation: { delivery: "paired_owner", authorized: true } });
    await channel.close();
    await stopServer();

    const draft = incoming("draft", "第二笔帮我拟一下，先别发");
    getUpdates.mockResolvedValueOnce({ messages: [
      list, incoming("explain", "为什么第二笔排在这里？"), incoming("repeat", "刚才的清单再说一遍"), draft, draft,
      incoming("execute", "发给买家，再确认报价"),
    ], next_sync_buf: "after-restart", longpoll_timeout_ms: 35_000 });
    channel = newChannel(config);
    await startServer();
    channel.restore();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(6), { timeout: 3000 });
    expect(getUpdates.mock.calls.some(([cursor]) => cursor === "before-restart")).toBe(true);
    expect(sendMessage.mock.calls[2]?.[0].text).toContain("按等待时长排在这一位");
    expect(sendMessage.mock.calls[3]?.[0].text).toBe(firstList);
    expect(sendMessage.mock.calls[4]?.[0]).toMatchObject({ context_token: "context-draft", text: expect.stringContaining("普通跟进草稿，尚未发送给买家") });
    expect(sendMessage.mock.calls[5]?.[0].text).toContain("正式操作请到商家工作台");
    expect(sendMessage.mock.calls.every(([out]) => out.to_user_id === credentials.ilink_user_id)).toBe(true);
    expect(JSON.stringify(sendMessage.mock.calls.map(([out]) => out.text))).not.toMatch(/private-inquiry|PRIVATE-SKU|fixture-bot-secret/);
    const drafts = await (await fetch(url + ENDPOINT + "/reply-drafts", { headers: { cookie: owner.cookie } })).json();
    expect(drafts).toMatchObject({ items: [expect.objectContaining({ inquiry: inquiries[1]!.id, version: 1 })] });

    const fresh = await login();
    expect((await request("/revoke-conversation", fresh)).status).toBe(200);
    getUpdates.mockResolvedValueOnce({ messages: [incoming("after-revoke", "今天有什么要跟进的？")],
      next_sync_buf: "revoked", longpoll_timeout_ms: 35_000 });
    await vi.waitFor(() => expect(getUpdates.mock.calls.some(([cursor]) => cursor === "revoked")).toBe(true), { timeout: 3500 });
    expect(sendMessage).toHaveBeenCalledTimes(6);
  }, 12_000);

  it("shows exact inventory only to the owner and never uses a failed or cross-merchant read", async () => {
    await stopServer();
    await channel.close();
    const product: ExactMerchantProduct = {
      merchant_id: MERCHANT, sku: "SKU-ONE", title: "test product", description: "fixture private details",
      category: "test", tags: [], stock: 0, currency: "CNY", price_minor: "12345",
      currency_table_version: "fixture", authority_version: 1, delivery_attributes: [], handoff_destination: "fixture-private-route",
    };
    const exact = vi.fn(async (sku: string) => {
      if (sku === "SKU-MISSING") throw new MerchantClientError("not_found", "fixture missing");
      if (sku === "SKU-DOWN") throw new MerchantClientError("transient", "fixture private diagnostic");
      if (sku === "SKU-UNKNOWN") return { ...product, sku, stock: NaN };
      if (sku === "SKU-OTHER") return { ...product, sku, merchant_id: "other-merchant", stock: 99 };
      return { ...product, sku };
    });
    channel = newChannel({
      enabled: true, ownerRevision: (id) => id === "fixture-owner" ? "fixture-revision" : undefined,
      workbenchOrigin: ORIGIN, source: { list: () => [], get: () => undefined },
      inventory: createOwnerInventoryReader(MERCHANT, exact, () => now),
    });
    await startServer();
    const owner = await login();
    const attempt = await begin(owner);
    getQrcodeStatus.mockResolvedValueOnce(confirmed);
    expect((await request("/poll", owner, attempt)).status).toBe(200);
    for (const [index, [sku, expected]] of [
      ["SKU-ONE", "目录库存：0"], ["SKU-MISSING", "未找到 SKU-MISSING"],
      ["SKU-UNKNOWN", "未提供 SKU-UNKNOWN 的有效库存"], ["SKU-OTHER", "暂时无法核实精确库存来源"],
      ["SKU-DOWN", "暂时无法核实精确库存来源"],
    ].entries()) {
      getUpdates.mockResolvedValueOnce({
        messages: [{ account: credentials.ilink_user_id!, from_user_id: credentials.ilink_user_id!,
          direct_text: true, text: `查库存 ${sku}`, message_id: `inventory-${index}`, context_token: "fixture-context" }],
        next_sync_buf: `inventory-cursor-${index}`, longpoll_timeout_ms: 35000,
      });
      const preview = await vi.waitFor(async () => {
        const status = await (await request("", owner)).json() as { conversation: { preview: string; last_received_at: number } };
        expect(exact).toHaveBeenCalledTimes(index + 1);
        expect(status.conversation.preview).toContain(expected);
        return status.conversation.preview;
      }, { timeout: 3000 });
      expect(preview).not.toMatch(/12345|99|fixture private|fixture-private/);
      if (index === 0) expect(preview).toContain("不是上游库存更新时间或供货承诺");
    }
    expect((await request("", await login("operator"))).status).toBe(403);
    expect((await request("", await login("owner", "other-merchant"))).status).toBe(404);
    expect(exact.mock.calls).toEqual([["SKU-ONE"], ["SKU-MISSING"], ["SKU-UNKNOWN"], ["SKU-OTHER"], ["SKU-DOWN"]]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("restores the same binding on restart but does not start a second poller in the same data directory", async () => {
    const owner = await login();
    const attempt = await begin(owner);
    getQrcodeStatus.mockResolvedValueOnce(confirmed);
    getUpdates.mockRejectedValueOnce(new WeixinError("session_stale", "fixture secret detail"));
    expect((await request("/poll", owner, attempt)).status).toBe(200);
    expect(await (await request("", owner)).json()).toEqual({ status: "reconnect_required", configured: true });
    const replacement = newChannel();
    try {
      expect(replacement.status()).toEqual({ status: "unavailable", configured: false });
      expect(getUpdates).toHaveBeenCalledTimes(1);
      await channel.close();
      expect(replacement.status()).toEqual({ status: "checking", configured: true });
      await vi.waitFor(() => expect(replacement.status()).toEqual({ status: "connected", configured: true }));
      expect(getUpdates).toHaveBeenCalledTimes(2);
    } finally {
      await replacement.close();
    }
  });
});
