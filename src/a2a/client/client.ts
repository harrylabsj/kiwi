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
 * A2A JSONRPC binding 出站 client（WP1）。
 *
 * 方法面：SendMessage（Text Part + Data Part 可携带 KNP envelope）、GetTask。
 * 响应解析为结构化 A2ATask。全部失败路径 fail-closed：
 *
 * - 构造时对端点 URL 做静态 SSRF/URL 校验（unsafe_target）；
 * - 请求前做 DNS 复查（主机名解析出的 IP 不得落在私网/保留段）；
 * - timeout / network / 非 2xx / JSON-RPC error / 畸形响应 / schema 校验
 *   统一抛 A2AClientError，绝不隐式重试或降级到其他 channel（不变量 21）。
 *
 * 零新增依赖：Node 22 原生 fetch + AbortController + node:crypto randomUUID。
 */

import { createPinnedFetch, PinnedFetchError } from "../../merchant-gateway/pinned-fetch.js";
import { awaitWithAbort, createRequestBudget, finishRequestResponse, type ReadRequestOptions } from "../../net/request-budget.js";
import { randomUUID } from "node:crypto";
import { A2AClientError, invalidResponse } from "./error.js";
import { buildJsonRpcRequest, parseJsonRpcResponse, tryParseJsonRpcError } from "./jsonrpc.js";
import { parseTaskResult } from "./parse.js";
import type { A2AOutboundSigner, A2AMessage, A2AClientOptions, A2ATask } from "./types.js";
import { serializeUcpAgentHeader, UCP_AGENT_HEADER } from "../ucp-agent.js";
import { assertResolvableTargetUrl, assertSafeTargetUrl } from "./url-policy.js";
import { isRedirectResponse, readJsonBody, SafeHttpError } from "../../net/safe-http.js";
// issue 06：1.0 双栈（方法名/头/Part 编码）。
import {
  A2A_EXTENSIONS_HEADER,
  A2A_VERSION_HEADER,
  KNP_EXTENSION_PATH,
  SUPPORTED_A2A_VERSION,
} from "../v1/headers.js";
import { METHOD_GET_TASK, METHOD_SEND_MESSAGE } from "../v1/methods.js";
import { encodeV1Part } from "../v1/part.js";

/**
 * 去掉发送地址上唯一的 `sharecode` 参数，供"签名地址 == 发送地址去码"的
 * 同源约束校验使用。仅用于比较，不做任何业务用途。
 */
function stripSharecode(url: URL): string {
  const clone = new URL(url.href);
  clone.searchParams.delete("sharecode");
  return clone.href;
}

export class A2AClient {
  /** 签名地址：签名覆盖的就是它（WorkBuddy 适配下不带分享参数）。 */
  private readonly url: URL;
  /**
   * 实际发送地址。与签名地址只在 WorkBuddy 适配下不同（末尾多一个分享参数，
   * 平台网关校验后剥除）；其它情况恒等于签名地址。两者必须同源。
   */
  private readonly sendUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly customTransport: boolean;
  private readonly allowPrivateRanges: boolean;
  private readonly skipDnsCheck: boolean;
  private readonly resolveIp?: (hostname: string) => Promise<string[]>;
  private readonly headers: Record<string, string>;
  private readonly ucpAgentProfile?: string;
  private readonly signer?: A2AOutboundSigner;
  private readonly cookieJar?: import("../access/gateway-cookie-jar.js").GatewayCookieJar;
  private readonly version: "1.0" | "0.3";
  private readonly knpExtensionUri?: string;

  constructor(options: A2AClientOptions) {
    this.url = assertSafeTargetUrl(options.url, { allowPrivateRanges: options.allowPrivateRanges });
    const wire = options.sendUrl === undefined ? this.url : assertSafeTargetUrl(options.sendUrl, { allowPrivateRanges: options.allowPrivateRanges });
    if (wire.origin !== this.url.origin) {
      // 发送地址与签名地址必须同源：否则等于把凭据发给了另一个域。
      throw new A2AClientError("unsafe_target", "sendUrl must share the signing URL origin");
    }
    if (wire.href !== this.url.href && !(wire.searchParams.getAll("sharecode").length === 1 && stripSharecode(wire) === this.url.href)) {
      // 只允许"签名地址 + 一个分享参数"的差异；其它改写一律拒绝（不猜）。
      throw new A2AClientError("unsafe_target", "sendUrl may only add a single sharecode parameter");
    }
    this.sendUrl = wire;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.customTransport = options.fetchImpl !== undefined;
    this.fetchImpl = options.fetchImpl ?? createPinnedFetch({ resolveIp: options.resolveIp, allowPrivateRanges: options.allowPrivateRanges, skipDnsCheck: options.skipDnsCheck });
    this.allowPrivateRanges = options.allowPrivateRanges ?? false;
    this.skipDnsCheck = options.skipDnsCheck ?? false;
    this.resolveIp = options.resolveIp;
    this.headers = options.headers ?? {};
    this.ucpAgentProfile = options.ucpAgentProfile;
    this.signer = options.signer;
    this.cookieJar = options.cookieJar;
    // issue 09（方案 1）：默认 1.0——Card 声明 1.0 ↔ 默认 client 讲 1.0。
    // knpExtensionUri 缺省从端点 origin 派生（服务器默认 path），显式可覆盖。
    this.version = options.version ?? "1.0";
    this.knpExtensionUri =
      options.knpExtensionUri ??
      (this.version === "1.0" ? `${this.url.origin}${KNP_EXTENSION_PATH}` : undefined);
  }

  /**
   * 发送一条 Message（含 Text/Data Part）。返回远端 Task。
   * 1.0 模式：方法名 `SendMessage` + Part 编码为 1.0 统一 Part。
   */
  async sendMessage(message: A2AMessage, contextId?: string): Promise<A2ATask> {
    const wireMethod = this.version === "1.0" ? METHOD_SEND_MESSAGE : "message/send";
    const wireMessage =
      this.version === "1.0"
        ? { ...message, parts: message.parts.map(encodeV1Part) }
        : message;
    const result = await this.rpc(wireMethod, {
      message: wireMessage as unknown as Record<string, unknown>,
      ...(contextId !== undefined ? { contextId } : {}),
    });
    return result;
  }

  /** 按 taskId 拉取 Task 状态与 artifacts。1.0 模式方法名 `GetTask`。 */
  async getTask(taskId: string, options?: ReadRequestOptions): Promise<A2ATask> {
    const wireMethod = this.version === "1.0" ? METHOD_GET_TASK : "tasks/get";
    return this.rpc(wireMethod, { id: taskId }, options);
  }

  private async rpc(method: string, params: unknown, options?: ReadRequestOptions): Promise<A2ATask> {
    const id = randomUUID();
    const body = JSON.stringify(buildJsonRpcRequest(method, params, id));

    const baseHeaders: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      // issue 06：1.0 模式每请求带 A2A-Version + A2A-Extensions（声明 KNP）。
      ...(this.version === "1.0"
        ? {
            [A2A_VERSION_HEADER]: SUPPORTED_A2A_VERSION,
            ...(this.knpExtensionUri !== undefined
              ? { [A2A_EXTENSIONS_HEADER]: this.knpExtensionUri }
              : {}),
          }
        : {}),
      // WP3 §25.1：配置了 buyer profile URI 时宣告 UCP-Agent（RFC 8941 Dictionary）。
      ...(this.ucpAgentProfile !== undefined
        ? { [UCP_AGENT_HEADER]: serializeUcpAgentHeader(this.ucpAgentProfile) }
        : {}),
      ...this.headers,
    };
    // WP5：配置了出站签名器时，对每个请求计算 HTTP Message Signature 头。
    // 注意：覆盖组件含 @method，必须是真实 HTTP 方法（POST），不是 JSON-RPC 方法名。
    // 网关 cookie 只发给同源（host-only 语义）；有 cookie 时发送地址就是签名地址
    // ——调用方据此不再追加分享码。
    const gatewayCookie = this.cookieJar?.get(this.sendUrl.origin);
    const headersWithCookie =
      gatewayCookie === undefined ? baseHeaders : { ...baseHeaders, cookie: gatewayCookie };
    const headers =
      this.signer === undefined
        ? headersWithCookie
        : { ...headersWithCookie, ...this.signer.sign({ method: "POST", url: this.url.href, body: Buffer.from(body, "utf8"), headers: headersWithCookie }) };

    const budget = createRequestBudget(this.timeoutMs, options);
    const { controller } = budget;

    let response: Response | undefined;
    let raw: unknown;
    try {
      try {
        if (this.customTransport) {
          await awaitWithAbort(assertResolvableTargetUrl(this.sendUrl, { allowPrivateRanges: this.allowPrivateRanges, skipDnsCheck: this.skipDnsCheck, resolveIp: this.resolveIp }), controller.signal);
        }
        controller.signal.throwIfAborted();
        response = await this.fetchImpl(this.sendUrl.href, {
          method: "POST",
          headers,
          body,
          // SSRF 防线：绝不跟随重定向——重定向目标不经过 SSRF/DNS 复查，且
          // 3xx 可把请求体/认证头转发给第三方。resolve/ucp 已实施，本处对齐。
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof A2AClientError) throw err;
        if (err instanceof PinnedFetchError && err.unsafeTarget) throw new A2AClientError("unsafe_target", err.message);
        if (controller.signal.aborted) {
          throw new A2AClientError("timeout", `A2A request timed out after ${budget.timeoutMs}ms`);
        }
        throw new A2AClientError(
          "network",
          `A2A request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 平台网关在首次带码访问时下发访问 cookie（30 天、host-only）；存下来供后续
      // 请求免带分享码。
      const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      if (setCookie.length > 0) this.cookieJar?.capture(this.sendUrl.origin, setCookie);

      if (isRedirectResponse(response)) {
        throw new A2AClientError(
          "http_status",
          `A2A endpoint must not redirect (HTTP ${response.status})`,
          { httpStatus: response.status },
        );
      }

      try {
        // 响应体读取在超时覆盖内（timer 活到 body 读完；对端停滞 body 也会
        // 被 abort 中断），且有大小上限（防恶意对端回传 GB 级 body 打爆内存）。
        raw = await readJsonBody(response, { signal: controller.signal });
        controller.signal.throwIfAborted();
      } catch (err) {
        if (controller.signal.aborted) {
          throw new A2AClientError("timeout", `A2A request timed out after ${budget.timeoutMs}ms`);
        }
        if (err instanceof SafeHttpError && err.code === "response_too_large") {
          throw invalidResponse(err.message);
        }
        if (!response.ok) {
          throw new A2AClientError("http_status", `A2A HTTP ${response.status} with non-JSON body`, {
            httpStatus: response.status,
          });
        }
        throw invalidResponse("response body is not JSON");
      }
    } finally {
      // 审查 P2-02：所有路径（fetch 拒绝 / redirect / 非 2xx / body 读失败）
      // 都必须清理超时 timer——此前只有 body 读的 finally 清理，fetch 抛错与
      // redirect/非 2xx 的提前 throw 会泄漏存活 timer 与 AbortController。
      finishRequestResponse(response, controller);
      budget.dispose();
    }

    if (!response.ok) {
      // 兼容：部分实现用非 2xx 状态码携带 JSON-RPC error 体。
      const jsonRpcError = tryParseJsonRpcError(raw, id);
      if (jsonRpcError !== undefined) {
        throw new A2AClientError("jsonrpc_error", jsonRpcError.message, {
          httpStatus: response.status,
          jsonrpcCode: jsonRpcError.code,
          jsonrpcData: jsonRpcError.data,
        });
      }
      throw new A2AClientError("http_status", `A2A HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }

    const parsed = parseJsonRpcResponse(raw, id);
    if ("error" in parsed) {
      throw new A2AClientError("jsonrpc_error", parsed.error.message, {
        jsonrpcCode: parsed.error.code,
        jsonrpcData: parsed.error.data,
      });
    }
    return parseTaskResult(parsed.result);
  }
}
