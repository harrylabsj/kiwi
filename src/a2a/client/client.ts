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

import { randomUUID } from "node:crypto";
import { A2AClientError, invalidResponse } from "./error.js";
import { buildJsonRpcRequest, parseJsonRpcResponse, tryParseJsonRpcError } from "./jsonrpc.js";
import { parseTaskResult } from "./parse.js";
import type { A2AOutboundSigner, A2AMessage, A2AClientOptions, A2ATask } from "./types.js";
import { serializeUcpAgentHeader, UCP_AGENT_HEADER } from "../ucp-agent.js";
import { assertResolvableTargetUrl, assertSafeTargetUrl } from "./url-policy.js";
import { isRedirectResponse, readJsonBody, SafeHttpError } from "../../net/safe-http.js";

export class A2AClient {
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly allowPrivateRanges: boolean;
  private readonly skipDnsCheck: boolean;
  private readonly resolveIp?: (hostname: string) => Promise<string[]>;
  private readonly headers: Record<string, string>;
  private readonly ucpAgentProfile?: string;
  private readonly signer?: A2AOutboundSigner;

  constructor(options: A2AClientOptions) {
    this.url = assertSafeTargetUrl(options.url, { allowPrivateRanges: options.allowPrivateRanges });
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.allowPrivateRanges = options.allowPrivateRanges ?? false;
    this.skipDnsCheck = options.skipDnsCheck ?? false;
    this.resolveIp = options.resolveIp;
    this.headers = options.headers ?? {};
    this.ucpAgentProfile = options.ucpAgentProfile;
    this.signer = options.signer;
  }

  /** A2A `message/send`：发送一条 Message（含 Text/Data Part）。返回远端 Task。 */
  async sendMessage(message: A2AMessage, contextId?: string): Promise<A2ATask> {
    const result = await this.rpc("message/send", {
      message: message as unknown as Record<string, unknown>,
      ...(contextId !== undefined ? { contextId } : {}),
    });
    return result;
  }

  /** A2A `tasks/get`：按 taskId 拉取 Task 状态与 artifacts。 */
  async getTask(taskId: string): Promise<A2ATask> {
    return this.rpc("tasks/get", { id: taskId });
  }

  private async rpc(method: string, params: unknown): Promise<A2ATask> {
    await assertResolvableTargetUrl(this.url, {
      allowPrivateRanges: this.allowPrivateRanges,
      skipDnsCheck: this.skipDnsCheck,
      resolveIp: this.resolveIp,
    });

    const id = randomUUID();
    const body = JSON.stringify(buildJsonRpcRequest(method, params, id));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const baseHeaders: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      // WP3 §25.1：配置了 buyer profile URI 时宣告 UCP-Agent（RFC 8941 Dictionary）。
      ...(this.ucpAgentProfile !== undefined
        ? { [UCP_AGENT_HEADER]: serializeUcpAgentHeader(this.ucpAgentProfile) }
        : {}),
      ...this.headers,
    };
    // WP5：配置了出站签名器时，对每个请求计算 HTTP Message Signature 头。
    // 注意：覆盖组件含 @method，必须是真实 HTTP 方法（POST），不是 JSON-RPC 方法名。
    const headers =
      this.signer === undefined
        ? baseHeaders
        : { ...baseHeaders, ...this.signer.sign({ method: "POST", url: this.url.href, body: Buffer.from(body, "utf8"), headers: baseHeaders }) };

    let response: Response;
    let raw: unknown;
    try {
      try {
        response = await this.fetchImpl(this.url.href, {
          method: "POST",
          headers,
          body,
          // SSRF 防线：绝不跟随重定向——重定向目标不经过 SSRF/DNS 复查，且
          // 3xx 可把请求体/认证头转发给第三方。resolve/ucp 已实施，本处对齐。
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new A2AClientError("timeout", `A2A request timed out after ${this.timeoutMs}ms`);
        }
        throw new A2AClientError(
          "network",
          `A2A request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

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
      } catch (err) {
        if (controller.signal.aborted) {
          throw new A2AClientError("timeout", `A2A request timed out after ${this.timeoutMs}ms`);
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
      clearTimeout(timer);
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
