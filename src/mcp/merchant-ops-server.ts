/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 店主经营 `/ops` 本机 HTTP 面（loopback-only，独立端口）。
 *
 * 与 MCP `/mcp`（9100）分端口：owner 数据（金额/底价/public_message）绝不
 * 出现在任何反向代理拓扑里。鉴权顺序：路径 → 双方 socket 均为 loopback IP
 * literal → 拒绝代理头 → Bearer（恒定时间）→ body 上限。
 *
 * token 未配置时调用方不启动本 listener（见 merchant-runtime-assembly），
 * 本模块不做“缺 token 放行”的降级。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";

import { isLoopbackHost } from "../a2a/client/url-policy.js";
import { NegotiationOpsError, type NegotiationOps } from "../merchant/negotiation-ops.js";

export const DEFAULT_MERCHANT_OPS_PORT = 9101;
export const DEFAULT_MERCHANT_OPS_HOST = "127.0.0.1";

const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_PER_MINUTE = 60;
const NO_STORE = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

export interface MerchantOpsServerOptions {
  service: NegotiationOps;
  token: string;
  /** 轮换窗口内仍接受的旧 token。 */
  previousToken?: string;
  port?: number;
}

export interface MerchantOpsServerHandle {
  host: string;
  port: number;
  close: () => Promise<void>;
}

function isLoopbackLiteral(address: string | undefined): boolean {
  return address !== undefined && isIP(address) !== 0 && isLoopbackHost(address);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenMatches(provided: string, expected: string): boolean {
  // 哈希后再恒定时间比较：既不泄露长度，也避免原文驻留比较分支。
  return timingSafeEqual(digest(provided), digest(expected));
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...NO_STORE,
  });
  res.end(text);
}

function rejectUnauthorized(res: ServerResponse): void {
  writeJson(res, 401, { ok: false, error: "unauthorized" });
}

function rejectNotLoopback(res: ServerResponse): void {
  writeJson(res, 403, { ok: false, error: "forbidden" });
}

function hasProxyHeaders(req: IncomingMessage): boolean {
  return (
    req.headers["x-forwarded-for"] !== undefined ||
    req.headers.forwarded !== undefined ||
    req.headers["x-real-ip"] !== undefined
  );
}

function hostHeaderMatches(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (typeof host !== "string" || host === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return false;
  const hostname = parsed.hostname;
  if (!isLoopbackLiteral(hostname)) return false;
  const declaredPort = parsed.port === "" ? 80 : Number(parsed.port);
  return declaredPort === port;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new NegotiationOpsError("invalid_request", "请求体过大");
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new NegotiationOpsError("invalid_request", "请求体不是合法 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NegotiationOpsError("invalid_request", "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function queryValue(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

function queryInt(url: URL, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = queryValue(url, name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new NegotiationOpsError("invalid_request", `${name} 不合法`);
  }
  return value;
}

export function createMerchantOpsHandler(options: {
  service: NegotiationOps;
  token: string;
  previousToken?: string;
  port: number;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const rate = new Map<string, { windowStart: number; count: number }>();

  const authenticate = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const provided = header.slice("Bearer ".length).trim();
    if (provided === "") return false;
    if (tokenMatches(provided, options.token)) return true;
    return options.previousToken !== undefined && tokenMatches(provided, options.previousToken);
  };

  const rateLimited = (key: string, now: number): boolean => {
    const entry = rate.get(key);
    if (entry === undefined || now - entry.windowStart > 60_000) {
      rate.set(key, { windowStart: now, count: 1 });
      if (rate.size > 2048) {
        for (const [k, v] of rate) if (now - v.windowStart > 60_000) rate.delete(k);
      }
      return false;
    }
    entry.count += 1;
    return entry.count > RATE_LIMIT_PER_MINUTE;
  };

  return (req, res) => {
    void (async () => {
      if (!isLoopbackLiteral(req.socket.localAddress) || !isLoopbackLiteral(req.socket.remoteAddress)) {
        rejectNotLoopback(res);
        return;
      }
      if (hasProxyHeaders(req)) {
        rejectNotLoopback(res);
        return;
      }
      if (!hostHeaderMatches(req, req.socket.localPort ?? options.port)) {
        rejectNotLoopback(res);
        return;
      }
      if (rateLimited(req.socket.remoteAddress ?? "unknown", Date.now())) {
        writeJson(res, 429, { ok: false, error: "rate_limited" });
        return;
      }
      if (!authenticate(req)) {
        rejectUnauthorized(res);
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      try {
        if (req.method === "GET" && url.pathname === "/ops/v1/info") {
          writeJson(res, 200, { ok: true, ...options.service.info() });
          return;
        }
        if (req.method === "GET" && url.pathname === "/ops/v1/negotiations") {
          const status = queryValue(url, "status");
          if (status !== undefined && !["active", "agreement", "all"].includes(status)) {
            throw new NegotiationOpsError("invalid_request", "status 不合法");
          }
          const result = options.service.listNegotiations({
            ...(status !== undefined
              ? { status: status as "active" | "agreement" | "all" }
              : {}),
            ...(queryValue(url, "cursor") !== undefined ? { cursor: queryValue(url, "cursor") } : {}),
            limit: queryInt(url, "limit", 20, 1, 100),
          });
          writeJson(res, 200, { ok: true, ...result });
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/ops/v1/negotiations/")) {
          const id = decodeURIComponent(url.pathname.slice("/ops/v1/negotiations/".length));
          if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
            throw new NegotiationOpsError("invalid_request", "negotiation_id 不合法");
          }
          writeJson(res, 200, { ok: true, negotiation: options.service.negotiationDetail(id) });
          return;
        }
        if (req.method === "GET" && url.pathname === "/ops/v1/approvals") {
          const status = queryValue(url, "status");
          if (
            status !== undefined &&
            !["pending", "approved", "consumed", "expired", "rejected", "all"].includes(status)
          ) {
            throw new NegotiationOpsError("invalid_request", "status 不合法");
          }
          const approvals = options.service.listApprovals(
            status as "pending" | "approved" | "consumed" | "expired" | "rejected" | "all" | undefined,
          );
          writeJson(res, 200, { ok: true, approvals });
          return;
        }
        if (req.method === "POST" && url.pathname === "/ops/v1/approvals/approve") {
          const body = await readJsonBody(req);
          const record = options.service.approve({
            approval_id: String(body.approval_id ?? ""),
            approved_minor: Number(body.approved_minor),
            ...(body.ttl_seconds !== undefined ? { ttl_seconds: Number(body.ttl_seconds) } : {}),
            actor: String(body.actor ?? ""),
          });
          writeJson(res, 200, { ok: true, approval: record });
          return;
        }
        if (req.method === "POST" && url.pathname === "/ops/v1/approvals/reject") {
          const body = await readJsonBody(req);
          const record = options.service.reject({
            approval_id: String(body.approval_id ?? ""),
            ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
            actor: String(body.actor ?? ""),
          });
          writeJson(res, 200, { ok: true, approval: record });
          return;
        }
        writeJson(res, 404, { ok: false, error: "not_found" });
      } catch (err) {
        if (err instanceof NegotiationOpsError) {
          writeJson(res, err.status, {
            ok: false,
            error: err.code,
            message: err.message,
            ...(err.reason !== undefined ? { reason: err.reason } : {}),
          });
          return;
        }
        writeJson(res, 500, { ok: false, error: "internal" });
      }
    })();
  };
}

export async function startMerchantOpsServer(
  options: MerchantOpsServerOptions,
): Promise<MerchantOpsServerHandle> {
  const host = DEFAULT_MERCHANT_OPS_HOST;
  const requestedPort = options.port ?? DEFAULT_MERCHANT_OPS_PORT;
  const server: Server = createServer(
    createMerchantOpsHandler({
      service: options.service,
      token: options.token,
      ...(options.previousToken !== undefined ? { previousToken: options.previousToken } : {}),
      port: requestedPort,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : requestedPort;
  return {
    host,
    port: boundPort,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
