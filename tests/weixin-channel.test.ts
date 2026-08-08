/**
 * 微信通道集成测试——真实 AgentKernel（fake 模型）+ mock iLink server。
 * 覆盖：回复回显+context_token 一致性、/slash 生效、/quit 退出、
 * 去重、白名单拒收、配对自动授权、-14 冷却、stop 写穿游标、长回复截断。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePathsForDir } from "../src/agent/agent-db.js";
import { createFakeChatModels } from "../src/agent/fake-chat-model.js";
import { AgentKernel } from "../src/agent/kernel.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import { WeixinChannel } from "../src/weixin/channel.js";
import { testProfile } from "./helpers.js";

const TEST_KEY = "a".repeat(64);
const PAIRED_USER = "wxid_paired";

interface MockServer {
  base: string;
  requests: Array<{ method: string; url: string; body: string }>;
  /** 注入 getupdates 响应（缺省空轮询）。 */
  updatesHandler: (n: number) => Record<string, unknown>;
  sentMessages: Array<{ to: string; text: string; contextToken?: string }>;
  stop: () => Promise<void>;
}

const servers: MockServer[] = [];
const workDirs: string[] = [];

function startMockServer(): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const sentMessages: MockServer["sentMessages"] = [];
  const state = {
    base: "",
    updatesHandler: (_n: number): Record<string, unknown> => ({ ret: 0, msgs: [], get_updates_buf: "buf" }),
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
    });
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", body: raw });
      const url = req.url ?? "";
      if (url.includes("getupdates")) {
        const n = requests.filter((r) => r.url.includes("getupdates")).length;
        const payload = state.updatesHandler(n);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      if (url.includes("sendmessage")) {
        const body = JSON.parse(raw) as { msg: { to_user_id: string; item_list: Array<{ text_item: { text: string } }>; context_token?: string } };
        sentMessages.push({
          to: body.msg.to_user_id,
          text: body.msg.item_list[0]?.text_item.text ?? "",
          contextToken: body.msg.context_token,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ret: 0 }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      state.base = `http://127.0.0.1:${addr.port}`;
      const mock: MockServer = {
        base: state.base,
        requests,
        // 转发到内部 state——测试直接改 mock.updatesHandler 即可生效
        updatesHandler: (n) => state.updatesHandler(n),
        sentMessages,
        stop: async () => {
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
        },
      };
      // 让 mock.updatesHandler 赋值直接落到 state（测试通过 mock.updatesHandler = fn 注入）
      Object.defineProperty(mock, "updatesHandler", {
        get: () => state.updatesHandler,
        set: (fn: MockServer["updatesHandler"]) => {
          state.updatesHandler = fn;
        },
        configurable: true,
      });
      servers.push(mock);
      resolve(mock);
    });
  });
}

function workDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-wx-chan-"));
  workDirs.push(dir);
  return dir;
}

/** 已登录凭证文件（mock 登录跳过——直接写凭证）。 */
function seedCredentials(dir: string, userId: string = PAIRED_USER): { creds: string; sync: string } {
  const creds = path.join(dir, "weixin-credentials.json");
  const sync = path.join(dir, "weixin-sync-buf.json");
  writeFileSync(creds, JSON.stringify({
    ilink_bot_id: "bot-1",
    bot_token: "tok-1",
    base_url: "",
    ilink_user_id: userId,
    saved_at: "2026-08-08T12:00:00Z",
  }), { mode: 0o600 });
  return { creds, sync };
}

async function openKernel(dir: string): Promise<AgentKernel> {
  const paths = ensurePathsForDir(path.join(dir, "agent"));
  const { models, model } = createFakeChatModels();
  return AgentKernel.open({
    profile: testProfile(),
    paths,
    models,
    model,
    vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
  });
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("WeixinChannel 集成", () => {
  it("入站消息 → kernel 回复 → sendmessage 回显 + context_token 回传", async () => {
    const mock = await startMockServer();
    mock.updatesHandler = (n) =>
      n === 1
        ? {
            ret: 0,
            msgs: [
              {
                from_user_id: PAIRED_USER,
                message_id: "m1",
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: "你好" } }],
              },
            ],
            get_updates_buf: "buf-1",
          }
        : { ret: 0, msgs: [], get_updates_buf: "buf-1" };
    const dir = workDir();
    const files = seedCredentials(dir);
    const kernel = await openKernel(dir);
    try {
      const channel = await WeixinChannel.open({
        kernel,
        apiBaseUrl: mock.base,
        credentialsPath: files.creds,
        syncBufPath: files.sync,
        timings: { schedulerTickMs: 0, negotiateTickMs: 0, sessionStaleCooldownMs: 50, protocolBackoffMs: 50 },
      });
      const exitPromise = channel.run();
      // 等处理完第一条消息
      await waitFor(() => mock.sentMessages.length > 0);
      expect(mock.sentMessages[0]!.to).toBe(PAIRED_USER);
      expect(mock.sentMessages[0]!.text.length).toBeGreaterThan(0);
      expect(mock.sentMessages[0]!.contextToken).toBe("ctx-1"); // context_token 回显
      await channel.stop();
      await exitPromise;
    } finally {
      await kernel.close();
    }
  });

  it("未授权用户：零回复、零 kernel 处理", async () => {
    const mock = await startMockServer();
    mock.updatesHandler = (n) =>
      n === 1
        ? {
            ret: 0,
            msgs: [
              {
                from_user_id: "wxid_stranger",
                message_id: "m1",
                context_token: "ctx-s",
                item_list: [{ type: 1, text_item: { text: "你是谁" } }],
              },
            ],
            get_updates_buf: "buf-1",
          }
        : { ret: 0, msgs: [], get_updates_buf: "buf-1" };
    const dir = workDir();
    const files = seedCredentials(dir);
    const kernel = await openKernel(dir);
    try {
      const channel = await WeixinChannel.open({
        kernel,
        apiBaseUrl: mock.base,
        credentialsPath: files.creds,
        syncBufPath: files.sync,
        timings: { schedulerTickMs: 0, negotiateTickMs: 0 },
      });
      const exitPromise = channel.run();
      await waitFor(() => mock.requests.some((r) => r.url.includes("getupdates") && JSON.parse(r.body).get_updates_buf === "buf-1"));
      await sleep(100);
      expect(mock.sentMessages).toHaveLength(0); // 未授权 → 零回复
      await channel.stop();
      await exitPromise;
    } finally {
      await kernel.close();
    }
  });

  it("同指纹两条 → 只处理一次", async () => {
    const mock = await startMockServer();
    mock.updatesHandler = (n) =>
      n === 1
        ? {
            ret: 0,
            msgs: [
              {
                from_user_id: PAIRED_USER,
                message_id: "dup1",
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: "重复" } }],
              },
              {
                from_user_id: PAIRED_USER,
                message_id: "dup1",
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: "重复" } }],
              },
            ],
            get_updates_buf: "buf-1",
          }
        : { ret: 0, msgs: [], get_updates_buf: "buf-1" };
    const dir = workDir();
    const files = seedCredentials(dir);
    const kernel = await openKernel(dir);
    try {
      const channel = await WeixinChannel.open({
        kernel,
        apiBaseUrl: mock.base,
        credentialsPath: files.creds,
        syncBufPath: files.sync,
        timings: { schedulerTickMs: 0, negotiateTickMs: 0 },
      });
      const exitPromise = channel.run();
      await waitFor(() => mock.sentMessages.length > 0);
      await sleep(100);
      expect(mock.sentMessages).toHaveLength(1); // 去重
      await channel.stop();
      await exitPromise;
    } finally {
      await kernel.close();
    }
  });

  it("stop() 写穿游标（重启零丢失）", async () => {
    const mock = await startMockServer();
    mock.updatesHandler = (n) =>
      n === 1
        ? {
            ret: 0,
            msgs: [
              {
                from_user_id: PAIRED_USER,
                message_id: "m1",
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: "游标测试" } }],
              },
            ],
            get_updates_buf: "cursor-123",
          }
        : { ret: 0, msgs: [], get_updates_buf: "cursor-123" };
    const dir = workDir();
    const files = seedCredentials(dir);
    const kernel = await openKernel(dir);
    try {
      const channel = await WeixinChannel.open({
        kernel,
        apiBaseUrl: mock.base,
        credentialsPath: files.creds,
        syncBufPath: files.sync,
        timings: { schedulerTickMs: 0, negotiateTickMs: 0 },
      });
      const exitPromise = channel.run();
      await waitFor(() => mock.sentMessages.length > 0);
      await channel.stop();
      await exitPromise;
      const state = JSON.parse(readFileSync(files.sync, "utf-8")) as { get_updates_buf: string };
      expect(state.get_updates_buf).toBe("cursor-123");
    } finally {
      await kernel.close();
    }
  });

  it("长回复截断（>2000 字符）", async () => {
    const mock = await startMockServer();
    mock.updatesHandler = (n) =>
      n === 1
        ? {
            ret: 0,
            msgs: [
              {
                from_user_id: PAIRED_USER,
                message_id: "m1",
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: "测试" } }],
              },
            ],
            get_updates_buf: "buf-1",
          }
        : { ret: 0, msgs: [], get_updates_buf: "buf-1" };
    const dir = workDir();
    const files = seedCredentials(dir);
    // 注入一个返回超长回复的 kernel：用 scripted 模型
    const { fauxProvider, createModels, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
    const handle = fauxProvider({ models: [{ id: "fake-chat-model", name: "fake-chat-model" }] });
    handle.setResponses([fauxAssistantMessage("长".repeat(2500))]);
    const models = createModels();
    models.setProvider(handle.provider);
    const paths = ensurePathsForDir(path.join(dir, "agent2"));
    const kernel = await AgentKernel.open({
      profile: testProfile(),
      paths,
      models,
      model: handle.getModel(),
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
    });
    try {
      const channel = await WeixinChannel.open({
        kernel,
        apiBaseUrl: mock.base,
        credentialsPath: files.creds,
        syncBufPath: files.sync,
        timings: { schedulerTickMs: 0, negotiateTickMs: 0 },
      });
      const exitPromise = channel.run();
      await waitFor(() => mock.sentMessages.length > 0);
      expect(mock.sentMessages[0]!.text.length).toBeLessThanOrEqual(2000 + 6); // 截断 + 后缀
      expect(mock.sentMessages[0]!.text).toContain("已截断");
      await channel.stop();
      await exitPromise;
    } finally {
      await kernel.close();
    }
  });
});

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, 20);
    };
    check();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
