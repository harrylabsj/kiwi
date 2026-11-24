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
import type { IlinkClient } from "../src/weixin/ilink-client.js";
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

  function newChannel() {
    return new MerchantWeixinChannel({
      dataDir: dir, merchantId: MERCHANT, now: () => now,
      client: () => ({ getBotQrcode, getQrcodeStatus, getUpdates, sendMessage, setBaseUrl }),
    });
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
  });

  afterEach(async () => {
    await channel.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
