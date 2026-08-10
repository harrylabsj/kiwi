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
 * Commerce Agent Catalog 注册 client（发布侧）——merchant 把自己注册进 catalog，
 * 供 buyer 经 catalog 发现（消费侧在 source.ts / resolve.ts）。
 *
 * POST /v1/agent-catalog/agents/register（kiwi-catalog §10.2）：
 *   - `domain` 必填（catalog 规范化 canonical domain；本地直连用占位域名）；
 *   - `agent_card_url` / `ucp_profile_url`：merchant 自己 A2A server 的 well-known。
 * 返回 catalog_agent_id + status；非 2xx / error 信封 → fail closed（抛 CatalogSourceError）。
 */

import { createHmac } from "node:crypto";
import { CatalogSourceError } from "./errors.js";

export interface CatalogRegisterInput {
  /** catalog 服务 base URL（如 http://127.0.0.1:8600）。 */
  catalogBaseUrl: string;
  /** 注册域名（必填，catalog 规范化）。 */
  domain: string;
  /** merchant 自己的 Agent Card well-known URL。 */
  agentCardUrl: string;
  /** merchant 自己的 UCP profile well-known URL（可选）。 */
  ucpProfileUrl?: string;
  /** 绑定 merchant_id（owner 语义，可选）。 */
  merchantId?: string;
  /**
   * KIWI_CATALOG_OWNER_TOKEN_SECRET：绑定 merchant_id 时用于派生 owner_token
   * （HMAC-SHA256("kiwi-catalog-owner:" + merchant_id)）。未提供则按公开
   * 自助注册（不带 merchant_id）处理。
   */
  ownerTokenSecret?: string;
  /**
   * 直接传入的 merchant owner token（随机落库路径，v12+ 双路径校验）——
   * 平台 secret 不应出现在商家服务器，商家用自己签发/找回的随机 token
   * 绑定 merchant_id。优先级高于 ownerTokenSecret。
   */
  ownerToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CatalogRegisterResult {
  ok: boolean;
  catalogAgentId?: string;
  status?: string;
  verificationEnqueued?: boolean;
}

/** 规范化 catalog base URL：去掉尾部斜杠。 */
export function normalizeCatalogBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * 注册一个 agent 到 catalog（fail closed：非 2xx 或 error 信封 → 抛错）。
 * 幂等：同 domain + agent_card_url 重复注册由 catalog 侧幂等处理，安全可重试。
 */
export async function registerCatalogAgent(
  input: CatalogRegisterInput,
): Promise<CatalogRegisterResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const base = normalizeCatalogBaseUrl(input.catalogBaseUrl);
  const body: Record<string, string> = {
    domain: input.domain,
    agent_card_url: input.agentCardUrl,
  };
  if (input.ucpProfileUrl !== undefined) body.ucp_profile_url = input.ucpProfileUrl;
  // owner 语义：有 merchantId 时绑定 merchant_id——token 来源二选一：
  //   1) ownerToken 直传（随机落库路径，商家自己的凭证，优先）；
  //   2) ownerTokenSecret HMAC 派生（legacy 路径，需平台 secret）。
  // 都没有则退回公开自助注册（不带 merchant_id，避免 catalog 拒收）。
  if (input.merchantId !== undefined) {
    if (input.ownerToken !== undefined && input.ownerToken !== "") {
      body.merchant_id = input.merchantId;
      body.owner_token = input.ownerToken;
    } else if (input.ownerTokenSecret !== undefined) {
      body.merchant_id = input.merchantId;
      body.owner_token = createHmac("sha256", input.ownerTokenSecret)
        .update(`kiwi-catalog-owner:${input.merchantId}`)
        .digest("hex");
    }
  }

  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/agent-catalog/agents/register`, {
      method: "POST",
      // 审查 P3（出站纪律，同 safe-http）：请求体携带 owner_token（凭据）——
      // 绝不跟随 3xx（重定向把 token body 转发到第三方 host）；超时覆盖
      // 响应体读取。
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: input.timeoutMs === undefined ? undefined : AbortSignal.timeout(input.timeoutMs),
    });
  } catch (err) {
    throw new CatalogSourceError(
      "request_failed",
      `catalog register network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3xx 在 manual 模式下不进 res.ok → 下方按失败处理（fail-closed）。
  let payload: Record<string, unknown>;
  try {
    // 响应体大小上限（与 safe-http 纪律一致；此前 res.json() 无上限）。
    const raw = await res.arrayBuffer();
    if (raw.byteLength > 2 * 1024 * 1024) {
      throw new Error("response exceeds 2MB");
    }
    const text = new TextDecoder("utf-8").decode(raw);
    payload = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    payload = {};
  }
  if (!res.ok || payload.ok === false) {
    const detail =
      typeof payload.error === "string" ? payload.error : `HTTP ${res.status}`;
    throw new CatalogSourceError("request_failed", `catalog register failed: ${detail}`);
  }
  const agent = payload.catalog_agent as Record<string, unknown> | undefined;
  return {
    ok: true,
    catalogAgentId: typeof agent?.catalog_agent_id === "string" ? agent.catalog_agent_id : undefined,
    status: typeof agent?.status === "string" ? agent.status : undefined,
    verificationEnqueued: payload.verification_enqueued === true,
  };
}
