/**
 * Kiwi v1.1 Transaction Handoff（WP2）— UCP Checkout HTTP 客户端（原生 fetch）。
 *
 * 网络面（全部 fail-closed，§4.6）：
 *   - SSRF 复用 a2a url-policy：构造时静态校验 endpoint（unsafe_target），
 *     每个请求前 DNS 复查解析 IP（unsafe_target）；
 *   - 超时：AbortController（timeoutMs，缺省 10s）；
 *   - 非 2xx / 畸形响应：非 2xx 若携带合法 UCP error envelope 仍解析（供消息算法
 *     分支），否则 bad_status；2xx 非 JSON / 结构非法 → malformed；
 *   - UCP-Agent 头（RFC 8941 Dictionary，§25.1）：buyer 配置了 profile URI 时注入。
 *
 * 零新增依赖：Node 22 原生 fetch + AbortController。
 */

import { assertResolvableTargetUrl, assertSafeTargetUrl } from "../../a2a/client/url-policy.js";
import { serializeUcpAgentHeader, UCP_AGENT_HEADER } from "../../a2a/ucp-agent.js";
import { UcpCheckoutParseError, parseUcpCheckoutResponse } from "./parse.js";
import type { UcpCheckoutResponse } from "./types.js";

/** REST binding 路径（UCP 2026-04-08：`POST {endpoint}/checkout-sessions`）。 */
export const CHECKOUT_SESSIONS_PATH = "/checkout-sessions";
export const CHECKOUT_COMPLETE_SUFFIX = "/complete";
export const CHECKOUT_CANCEL_SUFFIX = "/cancel";

export type UcpCheckoutHttpErrorCode =
  | "unsafe_target"
  | "timeout"
  | "network"
  | "bad_status"
  | "malformed";

export interface UcpCheckoutHttpError {
  kind: "error";
  code: UcpCheckoutHttpErrorCode;
  reason: string;
  status?: number;
}

export type UcpCheckoutHttpResult =
  | { kind: "ok"; status: number; response: UcpCheckoutResponse }
  | UcpCheckoutHttpError;

export interface UcpCheckoutHttpClientOptions {
  endpoint: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowPrivateRanges?: boolean;
  skipDnsCheck?: boolean;
  resolveIp?: (hostname: string) => Promise<string[]>;
  /** buyer 的 UCP profile URI；配置时注入 `UCP-Agent: profile="<uri>"`。 */
  ucpAgentProfile?: string;
  headers?: Record<string, string>;
}

function httpError(
  code: UcpCheckoutHttpErrorCode,
  reason: string,
  status?: number,
): UcpCheckoutHttpError {
  return { kind: "error", code, reason, status };
}

export class UcpCheckoutHttpClient {
  /** 规范化 endpoint（无尾部 `/`）。 */
  readonly endpoint: string;
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly allowPrivateRanges: boolean;
  private readonly skipDnsCheck: boolean;
  private readonly resolveIp?: (hostname: string) => Promise<string[]>;
  private readonly baseHeaders: Record<string, string>;

  constructor(options: UcpCheckoutHttpClientOptions) {
    const url = assertSafeTargetUrl(options.endpoint, {
      allowPrivateRanges: options.allowPrivateRanges,
    });
    this.url = url;
    this.endpoint = url.href.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.allowPrivateRanges = options.allowPrivateRanges ?? false;
    this.skipDnsCheck = options.skipDnsCheck ?? false;
    this.resolveIp = options.resolveIp;
    this.baseHeaders = {
      "content-type": "application/json",
      accept: "application/json",
      // WP3 §25.1：buyer 配置了 UCP profile URI 时宣告 UCP-Agent（RFC 8941 Dictionary）。
      ...(options.ucpAgentProfile !== undefined
        ? { [UCP_AGENT_HEADER]: serializeUcpAgentHeader(options.ucpAgentProfile) }
        : {}),
      ...options.headers,
    };
  }

  createSession(body: Record<string, unknown>): Promise<UcpCheckoutHttpResult> {
    return this.request("POST", CHECKOUT_SESSIONS_PATH, body);
  }

  getSession(sessionId: string): Promise<UcpCheckoutHttpResult> {
    return this.request("GET", `${CHECKOUT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}`, undefined);
  }

  updateSession(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<UcpCheckoutHttpResult> {
    return this.request("PUT", `${CHECKOUT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}`, body);
  }

  completeSession(sessionId: string, body: Record<string, unknown>): Promise<UcpCheckoutHttpResult> {
    return this.request(
      "POST",
      `${CHECKOUT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}${CHECKOUT_COMPLETE_SUFFIX}`,
      body,
    );
  }

  cancelSession(sessionId: string, body: Record<string, unknown>): Promise<UcpCheckoutHttpResult> {
    return this.request(
      "POST",
      `${CHECKOUT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}${CHECKOUT_CANCEL_SUFFIX}`,
      body,
    );
  }

  private async request(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<UcpCheckoutHttpResult> {
    // 请求前 DNS 复查：主机名解析出的每个 IP 都不得落在私网/保留段（DNS rebinding 缓解）。
    try {
      await assertResolvableTargetUrl(this.url, {
        allowPrivateRanges: this.allowPrivateRanges,
        skipDnsCheck: this.skipDnsCheck,
        resolveIp: this.resolveIp,
      });
    } catch (err) {
      return httpError(
        "unsafe_target",
        `UCP checkout endpoint rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = `${this.endpoint}${path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.baseHeaders,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return httpError("timeout", `UCP checkout request timed out after ${this.timeoutMs}ms`);
      }
      return httpError(
        "network",
        `UCP checkout request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return httpError(
        "malformed",
        `UCP checkout response is not JSON${response.ok ? "" : ` (http ${response.status})`}`,
        response.status,
      );
    }

    let parsed: UcpCheckoutResponse;
    try {
      parsed = parseUcpCheckoutResponse(raw);
    } catch (err) {
      const detail =
        err instanceof UcpCheckoutParseError ? err.message : err instanceof Error ? err.message : String(err);
      return httpError("malformed", `UCP checkout response malformed: ${detail}`, response.status);
    }

    if (!response.ok) {
      // 非 2xx：合法 UCP error envelope 仍走消息算法（fail-closed 结果，绝不 ok）；
      // success envelope 与 HTTP 层矛盾 → bad_status。
      if (parsed.ucp.status === "error") {
        return { kind: "ok", status: response.status, response: parsed };
      }
      return httpError(
        "bad_status",
        `UCP checkout HTTP ${response.status} with inconsistent success envelope`,
        response.status,
      );
    }
    return { kind: "ok", status: response.status, response: parsed };
  }
}
