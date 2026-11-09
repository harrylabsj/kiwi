#!/usr/bin/env node
/**
 * WorkBuddy 本机 stdio 适配器入口。
 *
 *   kiwi-workbuddy-adapter setup   本机受控页面绑定唯一实例 + OAuth PKCE
 *   kiwi-workbuddy-adapter serve   WorkBuddy stdio MCP（只读运营 + 只读对话）
 *   kiwi-workbuddy-adapter status  查看绑定状态（不含 token/sharecode）
 *   kiwi-workbuddy-adapter logout  清除本次 token（不撤旧授权时明确说明）
 *
 * 绑定/令牌/密钥只在本机数据目录；分享码只在 setup 表单输入并由加密 token
 * store 保存以支持续期，不进入模型、stdout 或日志。serve 只访问绑定文件里的
 * 固定实例，不接受工具参数指定 URL。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "../mcp/server.js";
import type { KiwiToolDefinition, McpCallToolResult } from "../mcp/types.js";
import {
  createFixedInstanceBinding,
  type FixedInstanceBinding,
} from "./binding.js";
import {
  createAuthorizationRequest,
  discoverOAuth,
  exchangeAdapterCode,
  refreshAdapterToken,
  registerAdapterClient,
  revokeAdapterToken,
  type AdapterOAuthMetadata,
  type AdapterAuthorizationRequest,
} from "./oauth.js";
import { withAdapterStateLock } from "./write-lock.js";
import { FixedInstanceMcpClient } from "./mcp-client.js";
import { TokenBoundClientCache } from "./client-cache.js";
import { AdapterTokenStore, type StoredAdapterToken } from "./token-store.js";

const DEFAULT_DATA_DIR = path.join(homedir(), ".kiwi", "workbuddy-adapter");
const BODY_LIMIT = 16 * 1024;
const SERVER_VERSION = "0.1.0";

interface StoredBinding {
  version: 1;
  instanceUrl: string;
  issuer: string;
  mcpUrl: string;
  metadata: AdapterOAuthMetadata;
  clientId: string;
  redirectUri: string;
  createdAt: string;
}

interface AdapterPaths {
  dir: string;
  binding: string;
  token: string;
  key: string;
}

function pathsFor(dir: string): AdapterPaths {
  return {
    dir,
    binding: path.join(dir, "binding.json"),
    token: path.join(dir, "token.enc"),
    key: path.join(dir, "adapter-key"),
  };
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function atomicJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    // chmod before rename; after a successful rename we must not throw and
    // leave the caller believing the commit failed.
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function loadOrCreateSecret(file: string): string {
  ensureDir(path.dirname(file));
  const read = (): string => {
    const value = readFileSync(file, "utf8").trim();
    if (value.length < 32) throw new Error("本机密钥文件损坏");
    return value;
  };
  if (existsSync(file)) return read();
  const secret = randomBytes(32).toString("base64url");
  try {
    // Exclusive create: concurrent status/setup/serve must not overwrite a key
    // another process just generated (that would orphan the encrypted token).
    writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    return secret;
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return read();
    throw error;
  }
}

function loadBinding(paths: AdapterPaths): StoredBinding | undefined {
  if (!existsSync(paths.binding)) return undefined;
  const value = JSON.parse(readFileSync(paths.binding, "utf8")) as StoredBinding;
  if (value.version !== 1) throw new Error("绑定文件版本不支持");
  return value;
}

function saveBinding(paths: AdapterPaths, binding: StoredBinding): void {
  ensureDir(paths.dir);
  atomicJson(paths.binding, binding);
}

/** 不含 token/sharecode 的绑定版本指纹，用于跨进程提交前复核。 */
function bindingSignature(binding: StoredBinding | undefined): string {
  if (binding === undefined) return "";
  return createHash("sha256")
    .update(
      [
        binding.instanceUrl,
        binding.issuer,
        binding.clientId,
        Array.isArray(binding.metadata?.scopes_supported)
          ? binding.metadata.scopes_supported.join(" ")
          : "",
      ].join("\u0000"),
    )
    .digest("hex");
}

function storeFor(paths: AdapterPaths, binding: FixedInstanceBinding): AdapterTokenStore {
  return new AdapterTokenStore({
    file: paths.token,
    binding,
    secret: loadOrCreateSecret(paths.key),
  });
}

function jsonResult(value: Record<string, unknown>, isError = false): McpCallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function failure(): McpCallToolResult {
  return {
    content: [{ type: "text", text: "商家实例操作失败（已收敛；请检查绑定、授权或网络）" }],
    isError: true,
  };
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handle: (args: Record<string, unknown>) => Promise<McpCallToolResult>,
): KiwiToolDefinition {
  return { name, description, inputSchema, handle };
}

function parseArgs(argv: string[]): { command: string; dataDir: string } {
  const command = argv[0] ?? "serve";
  let dataDir = process.env.KIWI_WORKBUDDY_ADAPTER_DIR ?? DEFAULT_DATA_DIR;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--data-dir" && argv[i + 1] !== undefined) {
      dataDir = argv[i + 1] as string;
      i += 1;
    }
  }
  return { command, dataDir };
}

class BoundInstance {
  private readonly cache = new TokenBoundClientCache<FixedInstanceMcpClient>();
  private clientInFlight:
    | { token: string; promise: Promise<FixedInstanceMcpClient> }
    | undefined;
  private tokenInFlight: Promise<StoredAdapterToken> | undefined;
  constructor(
    private readonly paths: AdapterPaths,
    private readonly binding: StoredBinding,
  ) {}

  async ensureToken(): Promise<StoredAdapterToken> {
    if (this.tokenInFlight !== undefined) return this.tokenInFlight;
    const run = this.doEnsureToken();
    this.tokenInFlight = run;
    try {
      return await run;
    } finally {
      if (this.tokenInFlight === run) this.tokenInFlight = undefined;
    }
  }

  private validateStoredToken(token: StoredAdapterToken): void {
    if (
      !token.scope.includes("merchant:read") ||
      token.scope.some((scope) => scope !== "merchant:read" && scope !== "merchant:owner")
    ) {
      throw new Error("stored token has unsupported scope");
    }
  }

  private async doEnsureToken(): Promise<StoredAdapterToken> {
    return withAdapterStateLock(this.paths.dir, async () => {
      // 锁内读最新 binding/token；运行中的 serve 不得在 setup 重绑定后继续使用旧实例。
      const currentBinding = loadBinding(this.paths);
      if (
        currentBinding === undefined ||
        currentBinding.instanceUrl !== this.binding.instanceUrl ||
        currentBinding.issuer !== this.binding.issuer ||
        currentBinding.clientId !== this.binding.clientId
      ) {
        throw new Error("instance binding changed");
      }
      const fixed = createFixedInstanceBinding({
        instanceUrl: this.binding.instanceUrl,
        issuer: this.binding.issuer,
      });
      const store = storeFor(this.paths, fixed);
      const current = store.load();
      if (current === undefined) throw new Error("adapter token missing");
      this.validateStoredToken(current);
      if (!store.isExpired(current)) return current;
      if (current.refresh_token === undefined) {
        throw new Error("access token 已过期且无 refresh token，需要重新授权");
      }

      // 锁覆盖“读取/判断过期/一次有界网络刷新/保存”：其他 serve 不会重复
      // 使用 rotating refresh token；setup/logout 会等待本次提交或超时 fail-closed。
      const refreshed = await refreshAdapterToken({
        binding: fixed,
        metadata: this.binding.metadata,
        shareCode: current.share_code ?? "",
        clientId: this.binding.clientId,
        refreshToken: current.refresh_token,
        scopes: current.scope,
      });

      // 防御性复核：即使有绕过锁的外部写入，也不能用旧 refresh 结果覆盖新绑定/token。
      const afterBinding = loadBinding(this.paths);
      if (
        afterBinding === undefined ||
        afterBinding.instanceUrl !== this.binding.instanceUrl ||
        afterBinding.issuer !== this.binding.issuer ||
        afterBinding.clientId !== this.binding.clientId
      ) {
        throw new Error("instance binding changed");
      }
      const latest = store.load();
      if (latest === undefined) throw new Error("adapter token missing");
      if (latest.access_token !== current.access_token) {
        this.validateStoredToken(latest);
        if (!store.isExpired(latest)) return latest;
        throw new Error("token changed concurrently; retry");
      }
      if (!store.isExpired(latest)) return latest;
      const merged: StoredAdapterToken = {
        ...refreshed,
        ...(current.share_code !== undefined ? { share_code: current.share_code } : {}),
      };
      this.validateStoredToken(merged);
      store.save(merged);
      return merged;
    });
  }

  async clientFor(): Promise<FixedInstanceMcpClient> {
    // 先检查/续期 token，再决定是否复用正在创建的 client；并发刷新共享一次。
    const token = await this.ensureToken();
    const existing = this.clientInFlight;
    if (existing !== undefined && existing.token === token.access_token) {
      return existing.promise;
    }
    const entry = {
      token: token.access_token,
      promise: this.cache.get(token, async (current) => {
        const fixed = createFixedInstanceBinding({
          instanceUrl: this.binding.instanceUrl,
          issuer: this.binding.issuer,
        });
        const client = new FixedInstanceMcpClient({
          binding: fixed,
          accessToken: current.access_token,
          shareCode: current.share_code ?? "",
        });
        await client.initialize();
        return client;
      }),
    };
    this.clientInFlight = entry;
    try {
      return await entry.promise;
    } finally {
      if (this.clientInFlight === entry) this.clientInFlight = undefined;
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    try {
      const client = await this.clientFor();
      const result = await client.callTool(name, args);
      return {
        content: [
          { type: "text", text: result.text || JSON.stringify(result.structuredContent ?? {}) },
        ],
        ...(result.isError ? { isError: true as const } : {}),
      };
    } catch {
      // 不在不确定是否已执行时重试；只读工具也避免重复对话 turn。
      this.cache.clear();
      return failure();
    }
  }
}

export function parseListNegotiationArgs(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const allowed = new Set(["cursor", "status", "limit"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const parsed: Record<string, unknown> = {};
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== "string" || !/^\d+$/.test(args.cursor)) return undefined;
    parsed.cursor = args.cursor;
  }
  if (args.status !== undefined) {
    if (args.status !== "active" && args.status !== "agreement" && args.status !== "all") {
      return undefined;
    }
    parsed.status = args.status;
  }
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 100
    ) {
      return undefined;
    }
    parsed.limit = args.limit;
  }
  return parsed;
}

async function serve(dataDir: string): Promise<number> {
  const paths = pathsFor(dataDir);
  const stored = loadBinding(paths);
  if (stored === undefined) {
    process.stderr.write("未绑定实例：请先运行 kiwi-workbuddy-adapter setup\n");
    return 2;
  }
  const fixed = createFixedInstanceBinding({
    instanceUrl: stored.instanceUrl,
    issuer: stored.issuer,
  });
  const store = storeFor(paths, fixed);
  if (store.load() === undefined) {
    process.stderr.write("未授权：请先运行 kiwi-workbuddy-adapter setup\n");
    return 2;
  }
  const bound = new BoundInstance(paths, stored);
  const tools: KiwiToolDefinition[] = [
    tool(
      "kiwi_merchant_connection_status",
      "读取本机绑定的固定商家实例与授权状态（不含 token/sharecode）。",
      { type: "object", properties: {}, additionalProperties: false },
      async () => {
        try {
          const token = await bound.ensureToken();
          return jsonResult({
            bound: true,
            instance: fixed.instanceOrigin,
            mcp_url: fixed.mcpUrl,
            scope: token.scope,
            expires_at: token.expires_at,
          });
        } catch {
          return failure();
        }
      },
    ),
    tool(
      "kiwi_merchant_get_operations_report",
      "读取本商家实例运营报告（只读；固定绑定实例）。",
      {
        type: "object",
        properties: {
          period: { type: "string", enum: ["day", "week", "month"] },
        },
        additionalProperties: false,
      },
      (args) => bound.call("kiwi_merchant_get_operations_report", args),
    ),
    tool(
      "kiwi_merchant_list_a2a_negotiations",
      "列出本商家实例 A2A 磋商（只读；支持 cursor/status/limit）。",
      {
        type: "object",
        properties: {
          cursor: { type: "string", pattern: "^\\d+$" },
          status: { type: "string", enum: ["active", "agreement", "all"] },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      (args) => {
        const parsed = parseListNegotiationArgs(args);
        if (parsed === undefined) {
          return Promise.resolve({
            content: [{ type: "text" as const, text: "参数无效：cursor/status/limit" }],
            isError: true as const,
          });
        }
        return bound.call("kiwi_merchant_list_a2a_negotiations", parsed);
      },
    ),
    tool(
      "kiwi_merchant_get_a2a_negotiation",
      "按 negotiation_id 读取本商家实例磋商详情（只读）。",
      {
        type: "object",
        properties: { negotiation_id: { type: "string" } },
        required: ["negotiation_id"],
        additionalProperties: false,
      },
      (args) => bound.call("kiwi_merchant_get_a2a_negotiation", args),
    ),
    tool(
      "kiwi_merchant_chat",
      "与本商家实例同一个云端 Kiwi 智能体只读多轮对话；返回 conversation_id。",
      {
        type: "object",
        properties: {
          message: { type: "string" },
          conversation_id: { type: "string" },
        },
        required: ["message"],
        additionalProperties: false,
      },
      (args) => bound.call("kiwi_merchant_chat", args),
    ),
  ];
  const server = new McpServer({
    tools,
    serverInfo: { name: "kiwi-workbuddy-adapter", version: SERVER_VERSION },
  });
  await server.serve();
  return 0;
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function html(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6}code{background:#eef3ee;padding:2px 5px;border-radius:4px}.err{color:#b3261e}input{width:100%;padding:10px;margin:6px 0;border:1px solid #ccd}button{padding:9px 18px;border:0;border-radius:999px;background:#1b5e20;color:#fff}</style></head><body>${body}</body></html>`;
}

export async function startSetupServer(
  dataDir: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const paths = pathsFor(dataDir);
  ensureDir(dataDir);
  const csrf = randomBytes(32).toString("base64url");
  const pending = new Map<string, {
    request: AdapterAuthorizationRequest;
    shareCode: string;
    binding: FixedInstanceBinding;
    metadata: AdapterOAuthMetadata;
    clientId: string;
    scopes: string[];
    generation: number;
    baseBinding: string;
  }>();
  const drafts = new Map<string, {
    binding: FixedInstanceBinding;
    metadata: AdapterOAuthMetadata;
    shareCode: string;
    generation: number;
    baseBinding: string;
  }>();
  let generation = 0;
  let origin = "";
  const server = createServer(async (request, response) => {
    try {
      if (String(request.headers.host ?? "") !== origin.replace("http://", "")) {
        response.writeHead(421).end("host invalid");
        return;
      }
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(
          html(
            "绑定商家实例",
            `<h1>绑定唯一商家实例</h1>
<p>本页面只在本机 ${origin} 打开。绑定后 WorkBuddy stdio 适配器只访问该固定实例。</p>
<form method="post" action="/bind">
<input type="hidden" name="csrf" value="${csrf}">
<label>实例 MCP HTTPS 地址（必须 /mcp）</label>
<input name="instance" placeholder="https://your-instance.example.com/mcp" required>
<label>分享凭据（仅门禁；不是商家身份）</label>
<input name="share" type="password" autocomplete="off" required>
<button type="submit">开始 OAuth 授权</button>
</form>
<p>分享凭据只保存在本机加密 token store，用于门禁请求与续期；不写入模型/日志。</p>`,
          ),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/bind") {
        if (String(request.headers.origin ?? "") !== origin) {
          response.writeHead(403).end("origin invalid");
          return;
        }
        const form = new URLSearchParams(await readBody(request));
        if (!safeEqual(form.get("csrf") ?? "", csrf)) {
          response.writeHead(403).end("csrf invalid");
          return;
        }
        const instanceUrl = (form.get("instance") ?? "").trim();
        const shareCode = (form.get("share") ?? "").trim();
        if (instanceUrl === "" || shareCode === "") {
          response.writeHead(400).end("missing fields");
          return;
        }
        // 新绑定一开始就使旧 draft/pending 失效；即使本次 discovery 失败，
        // 旧流程也不能回跳覆盖新选择。
        const baseBinding = bindingSignature(loadBinding(paths));
        generation += 1;
        drafts.clear();
        pending.clear();
        const binding = createFixedInstanceBinding({ instanceUrl });
        const metadata = await discoverOAuth(binding, shareCode);
        const draftId = randomBytes(24).toString("base64url");
        drafts.set(draftId, { binding, metadata, shareCode, generation, baseBinding });
        const ownerAvailable = metadata.scopes_supported.includes("merchant:owner");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(
          html(
            "确认授权范围",
            `<h1>确认授权范围</h1>
<p>实例：<code>${binding.instanceOrigin}</code></p>
<p>默认只申请 <code>merchant:read</code>。${ownerAvailable ? "该实例声明支持店主报价读取，可按需勾选；不勾选则不会申请 owner scope。" : "该实例未声明 merchant:owner，不能申请店主报价读取。"}</p>
<form method="post" action="/authorize">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="draft" value="${draftId}">
${ownerAvailable ? '<label><input type="checkbox" name="owner_scope" value="1" style="width:auto"> 同时申请 merchant:owner（商家本人明确选择；用于读取自己的报价）</label>' : ""}
<button type="submit">继续 OAuth 授权</button>
</form>`,
          ),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/authorize") {
        if (String(request.headers.origin ?? "") !== origin) {
          response.writeHead(403).end("origin invalid");
          return;
        }
        const form = new URLSearchParams(await readBody(request));
        if (!safeEqual(form.get("csrf") ?? "", csrf)) {
          response.writeHead(403).end("csrf invalid");
          return;
        }
        const draftId = form.get("draft") ?? "";
        const draft = drafts.get(draftId);
        if (draft === undefined || draft.generation !== generation) {
          response.writeHead(400).end("draft invalid or superseded");
          return;
        }
        const ownerRequested = form.get("owner_scope") === "1";
        if (ownerRequested && !draft.metadata.scopes_supported.includes("merchant:owner")) {
          response.writeHead(400).end("owner scope not supported by instance");
          return;
        }
        const scopes = ownerRequested ? ["merchant:read", "merchant:owner"] : ["merchant:read"];
        const redirectUri = `${origin}/callback`;
        const clientId = await registerAdapterClient(
          draft.binding,
          draft.metadata,
          redirectUri,
          draft.shareCode,
        );
        const auth = createAuthorizationRequest({
          binding: draft.binding,
          metadata: draft.metadata,
          clientId,
          redirectUri,
          shareCode: draft.shareCode,
          scopes,
        });
        drafts.delete(draftId);
        pending.set(auth.state, {
          request: auth,
          shareCode: draft.shareCode,
          binding: draft.binding,
          metadata: draft.metadata,
          clientId,
          scopes,
          generation: draft.generation,
          baseBinding: draft.baseBinding,
        });
        response.writeHead(303, { location: auth.url, "cache-control": "no-store" }).end();
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/callback")) {
        const url = new URL(request.url, origin);
        const state = url.searchParams.get("state") ?? "";
        const item = pending.get(state);
        if (item === undefined) {
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end(html("绑定失败", "<p class='err'>state 无效或已过期。</p>"));
          return;
        }
        pending.delete(state);
        if (item.generation !== generation) {
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end(html("绑定失败", "<p class='err'>该授权流程已被新的绑定取代，请重新开始。</p>"));
          return;
        }
        const code = url.searchParams.get("code") ?? "";
        if (url.searchParams.get("error") !== null || code === "") {
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end(html("绑定失败", "<p class='err'>授权被拒绝或缺少 code，请重新绑定。</p>"));
          return;
        }
        const token = await exchangeAdapterCode({
          binding: item.binding,
          metadata: item.metadata,
          shareCode: item.shareCode,
          clientId: item.clientId,
          redirectUri: `${origin}/callback`,
          code,
          verifier: item.request.verifier,
          scopes: item.scopes,
        });
        // 交换期间若商家开始了新绑定，旧流程不得覆盖新实例/新 token。
        if (item.generation !== generation) {
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end(html("绑定失败", "<p class='err'>该授权流程已被新的绑定取代，请重新开始。</p>"));
          return;
        }
        await withAdapterStateLock(paths.dir, () => {
          if (item.generation !== generation) {
            throw new Error("binding flow superseded");
          }
          // 跨进程复核：另一个 setup 已提交不同绑定时，本流程不得覆盖。
          if (bindingSignature(loadBinding(paths)) !== item.baseBinding) {
            throw new Error("binding changed by another setup");
          }
          const store = storeFor(paths, item.binding);
          const previousToken = existsSync(paths.token) ? readFileSync(paths.token) : undefined;
          try {
            store.save({ ...token, share_code: item.shareCode });
            saveBinding(paths, {
              version: 1,
              instanceUrl: item.binding.mcpUrl,
              issuer: item.binding.issuer,
              mcpUrl: item.binding.mcpUrl,
              metadata: item.metadata,
              clientId: item.clientId,
              redirectUri: `${origin}/callback`,
              createdAt: new Date().toISOString(),
            });
          } catch (error) {
            // 绑定写入失败时恢复旧 token，避免新 token 与旧 binding 交叉。
            if (previousToken !== undefined) {
              writeFileSync(paths.token, previousToken, { mode: 0o600 });
              chmodSync(paths.token, 0o600);
            } else {
              rmSync(paths.token, { force: true });
            }
            throw error;
          }
        });
        response.writeHead(303, { location: "/done", "cache-control": "no-store" }).end();
        return;
      }
      if (request.method === "GET" && request.url === "/done") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(
          html(
            "绑定完成",
            `<h1>绑定完成</h1><p>本机已保存固定实例绑定与加密 token。可以关闭本页面。</p>
<p>WorkBuddy 中配置本机 stdio 命令：<code>kiwi-workbuddy-adapter serve</code></p>`,
          ),
        );
        return;
      }
      response.writeHead(404).end("not found");
    } catch {
      response.writeHead(400).end("绑定失败（已收敛）");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function setup(dataDir: string): Promise<number> {
  const handle = await startSetupServer(dataDir);
  process.stdout.write(`本机绑定页面：${handle.origin}/\n`);
  process.stdout.write("请在浏览器完成商家授权；不要通过聊天/命令行传递分享凭据。\n");
  return 0;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function status(dataDir: string): Promise<number> {
  const paths = pathsFor(dataDir);
  if (!existsSync(paths.binding)) {
    process.stdout.write(JSON.stringify({ bound: false }) + "\n");
    return Promise.resolve(1);
  }
  return withAdapterStateLock(paths.dir, () => {
    const binding = loadBinding(paths);
    if (binding === undefined) {
      process.stdout.write(JSON.stringify({ bound: false }) + "\n");
      return 1;
    }
    const fixed = createFixedInstanceBinding({
      instanceUrl: binding.instanceUrl,
      issuer: binding.issuer,
    });
    const store = storeFor(paths, fixed);
    const token = store.load();
    const expired = token !== undefined && store.isExpired(token);
    process.stdout.write(
      JSON.stringify({
        bound: true,
        instance: fixed.instanceOrigin,
        mcp_url: fixed.mcpUrl,
        authorized: token !== undefined && !expired,
        expired,
        scope: token?.scope,
        expires_at: token?.expires_at,
      }) + "\n",
    );
    return token === undefined ? 1 : 0;
  });
}

async function logout(dataDir: string): Promise<number> {
  const paths = pathsFor(dataDir);
  if (!existsSync(paths.binding)) return 0;
  const snapshot = await withAdapterStateLock(paths.dir, () => {
    const binding = loadBinding(paths);
    if (binding === undefined) return undefined;
    const fixed = createFixedInstanceBinding({
      instanceUrl: binding.instanceUrl,
      issuer: binding.issuer,
    });
    const store = storeFor(paths, fixed);
    return { binding, fixed, store, token: store.load() };
  });
  if (snapshot === undefined) return 0;
  const { binding, fixed, store, token } = snapshot;
  if (token === undefined) {
    process.stdout.write(JSON.stringify({ cleared: true, revoked: false }) + "\n");
    return 0;
  }
  // 网络撤销不持锁；提交清理前在锁内复核 token 代次。
  const revokedAccess = await revokeAdapterToken({
    binding: fixed,
    metadata: binding.metadata,
    shareCode: token.share_code ?? "",
    token: token.access_token,
  });
  const revokedRefresh =
    token.refresh_token === undefined
      ? false
      : await revokeAdapterToken({
          binding: fixed,
          metadata: binding.metadata,
          shareCode: token.share_code ?? "",
          token: token.refresh_token,
        });
  await withAdapterStateLock(paths.dir, () => {
    const current = store.load();
    if (current !== undefined && current.access_token !== token.access_token) {
      throw new Error("token changed concurrently; logout not applied");
    }
    store.clear();
  });
  process.stdout.write(
    JSON.stringify({
      cleared: true,
      access_revoked: revokedAccess,
      refresh_revoked: revokedRefresh,
    }) + "\n",
  );
  return 0;
}

export async function runWorkbuddyAdapterCli(argv: string[]): Promise<number> {
  const { command, dataDir } = parseArgs(argv);
  try {
    if (command === "serve") return await serve(dataDir);
    if (command === "setup") return await setup(dataDir);
    if (command === "status") return await status(dataDir);
    if (command === "logout") return await logout(dataDir);
  } catch {
    process.stderr.write("适配器操作失败（已收敛；请检查本机绑定/密钥/网络）\n");
    return 2;
  }
  process.stderr.write("用法：kiwi-workbuddy-adapter setup|serve|status|logout [--data-dir DIR]\n");
  return 2;
}

const argv1 = process.argv[1];
if (argv1 !== undefined) {
  let isMain = false;
  try {
    isMain = realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    isMain = false;
  }
  if (isMain) {
    void runWorkbuddyAdapterCli(process.argv.slice(2)).then((code) => {
      if (code !== 0) process.exitCode = code;
    });
  }
}

// 供测试/上层调用；不导出真实 token。
export type { StoredBinding };
