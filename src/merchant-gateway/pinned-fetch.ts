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
 * 面向商家自有实例的**钉住式**出站请求（SSRF / DNS 重绑定加固）。
 *
 * 背景：商家实例地址由商家自己提供（自助绑定 / 配对码），属于不可信输入。
 * 只做静态校验（https + 非私网字面 IP）挡不住两类攻击：
 *
 *   1. **解析后落到内网**：域名静态看没问题，但解析出 10.x / 169.254 / ::1；
 *   2. **DNS 重绑定（TOCTOU）**：校验时解析到公网 IP，随后 fetch 再解析一次
 *      却拿到内网 IP。
 *
 * 本模块的做法：**一次解析、校验、然后直接用该 IP 建连**（`host: <ip>` +
 * `servername`/`Host: <主机名>`），不再给运行时第二次解析的机会——这就是钉住。
 * 校验规则复用 A2A 出站守卫（`assertResolvableTargetUrl`）：任一解析结果落在
 * 保留/私网段、或"公网域名解析到 loopback"，一律 fail-closed 拒绝。
 *
 * loopback 与字面 IP 不走钉住：前者是本地/同机形态（静态策略已允许且已在
 * 白名单内），后者没有解析步骤可被劫持。
 *
 * 只覆盖网关需要的调用形态（JSON/文本体的 GET/POST，不跟随重定向、读完整
 * 响应体），不是 fetch 的完整实现。
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";

import { isIP } from "node:net";

import { assertResolvableTargetUrl, isLoopbackHost } from "../a2a/client/url-policy.js";

export class PinnedFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedFetchError";
  }
}

/** 我们用到的那几个 fetch init 字段（避免依赖 DOM/undici 的类型名）。 */
interface FetchInit {
  method?: string;
  headers?: unknown;
  body?: unknown;
  signal?: unknown;
}

export interface PinnedFetchOptions {
  /** 自定义解析（测试用）；返回该主机名的全部 A/AAAA 记录。 */
  resolveIp?: (hostname: string) => Promise<string[]>;
  /** 请求超时（毫秒）；缺省由调用方通过 AbortSignal 控制。 */
  timeoutMs?: number;
}

type RequestFn = typeof httpRequest;

async function defaultResolve(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

/**
 * 请求头归一化：接受 Headers / 键值对数组 / 普通对象（调用方可能传 fetch 的
 * RequestInit.headers 或我们自己的字面量）。用 unknown 收口，避免依赖
 * 各类型定义里对 HeadersInit 的差异。
 */
function headersToObject(init: unknown): Record<string, string | undefined> {
  if (init === undefined || init === null) return {};
  if (init instanceof Headers) return Object.fromEntries(init.entries());
  if (Array.isArray(init)) {
    return Object.fromEntries(init as Array<[string, string]>);
  }
  if (typeof init === "object") return { ...(init as Record<string, string | undefined>) };
  return {};
}

/** 过滤掉 undefined 值（Node 的请求头不接受 undefined）。 */
function definedHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/** 字面 IP（v4/v6）判定：这些地址没有可被劫持的解析步骤。 */
function isIpLiteral(hostname: string): boolean {
  return isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
}

function nodeHeadersToPairs(
  headers: Record<string, string | string[] | undefined>,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    pairs.push([key, Array.isArray(value) ? value.join(", ") : value]);
  }
  return pairs;
}

/**
 * 解析 + 校验 + 选定一个可直连的 IP。
 *
 * 与 `assertResolvableTargetUrl` 同一套规则，但把「校验用的解析结果」原样
 * 返回给调用方去建连，消除两次解析之间的窗口。
 */
export async function resolvePinnedAddress(
  hostname: string,
  resolve: (hostname: string) => Promise<string[]>,
): Promise<string> {
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new PinnedFetchError(`无法解析实例主机名：${hostname}`);
  }
  if (addresses.length === 0) {
    throw new PinnedFetchError(`实例主机名未解析出任何地址：${hostname}`);
  }
  // 复用 A2A 守卫的判定（含"公网域名解析到 loopback 一律拒绝"），
  // 并固定用同一批解析结果做校验与建连。拒绝原因统一包装成 PinnedFetchError。
  try {
    await assertResolvableTargetUrl(new URL(`https://${hostname}/`), {
      resolveIp: async () => addresses,
    });
  } catch (err) {
    throw new PinnedFetchError(
      `实例主机名被出站策略拒绝：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const [first] = addresses;
  if (first === undefined) {
    throw new PinnedFetchError(`实例主机名未解析出任何地址：${hostname}`);
  }
  return first;
}

/**
 * 按**给定地址**建连（钉住的落点），HTTP 适配层：
 * `host: <address>` + `Host: <主机名>`（https 另加 servername 供 SNI/证书校验）。
 * 单独导出便于对本地服务做往返测试（不经过 DNS 策略）。
 */
export async function requestViaAddress(
  url: URL,
  address: string,
  init: FetchInit = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const headers = headersToObject(init.headers);
  const body = init.body;
  const secure = url.protocol === "https:";
  const request: RequestFn = secure ? (httpsRequest as RequestFn) : (httpRequest as RequestFn);
  const port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
  const defaultPort = secure ? "443" : "80";
  const hostHeader =
    url.port === "" || url.port === defaultPort ? url.hostname : `${url.hostname}:${url.port}`;

  return await new Promise<Response>((resolvePromise, rejectPromise) => {
    const req = request(
      {
        host: address,
        port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...definedHeaders(headers),
          host: hostHeader,
        },
        ...(secure ? { servername: url.hostname } : {}),
        ...(init.signal !== undefined && init.signal !== null
          ? { signal: init.signal as AbortSignal }
          : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolvePromise(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: nodeHeadersToPairs(res.headers),
            }),
          );
        });
        res.on("error", rejectPromise);
      },
    );
    req.on("error", (err) => {
      rejectPromise(
        err instanceof Error && err.name === "AbortError"
          ? err
          : new PinnedFetchError(`实例请求失败（${url.hostname}）：${err.message}`),
      );
    });
    if (typeof body === "string") req.write(body);
    req.end();
  });
}

/**
 * 构造一个把目标主机**钉在已校验 IP** 上的 fetch 实现。
 *
 * 语义与 fetch 的差异（故意为之）：不跟随重定向；响应体一次性读完（JSON-RPC
 * 体量小）；不处理 cookie / 流式上传。
 */
export function createPinnedFetch(options: PinnedFetchOptions = {}): typeof fetch {
  const resolve = options.resolveIp ?? defaultResolve;
  const pinnedFetch = async (
    input: string | URL | Request,
    init?: FetchInit,
  ): Promise<Response> => {
    const requestInit = init ?? {};
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const method = requestInit.method ?? (input instanceof Request ? input.method : "GET");
    const headers = {
      ...headersToObject(input instanceof Request ? input.headers : undefined),
      ...headersToObject(requestInit.headers),
    };
    const body = requestInit.body;

    // loopback / 字面 IP：无解析步骤可被劫持，直接按该主机建连（仍走同一适配层）
    // ——统一路径的另一个好处：不经过全局 fetch 的连接池，实例重启后不会因为
    // 复用到失效的 keep-alive 连接而出现一次 ECONNRESET（表现为 backend_unavailable）。
    if (isLoopbackHost(url.hostname) || isIpLiteral(url.hostname)) {
      return await requestViaAddress(url, url.hostname.replace(/^\[|\]$/g, ""), {
        method,
        headers,
        ...(body !== undefined && body !== null ? { body } : {}),
        ...(requestInit.signal !== undefined ? { signal: requestInit.signal } : {}),
      });
    }

    const pinnedIp = await resolvePinnedAddress(url.hostname, resolve);
    return await requestViaAddress(url, pinnedIp, {
      method,
      headers,
      ...(body !== undefined && body !== null ? { body } : {}),
      ...(requestInit.signal !== undefined ? { signal: requestInit.signal } : {}),
    });
  };
  return pinnedFetch as typeof fetch;
}
