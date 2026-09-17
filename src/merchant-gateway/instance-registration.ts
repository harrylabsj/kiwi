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
 * 商家实例自助绑定（设计 §8.4 第一期；安全设计见
 * docs/merchant-buddy/merchant-instance-pairing-design.md）。
 *
 * 绑定 = 商家（已验证 OAuth 会话）提交「实例 MCP 地址 + 实例内部令牌」，网关：
 *   1) 用注册表同一套 URL 策略校验地址（https 或 loopback http、路径 /mcp、
 *      无 userinfo/查询/片段、非保留主机名、非私网字面 IP）；
 *   2) **探活**：带该令牌调用实例的 initialize + tools/list，必须拿到合法
 *      JSON-RPC 结果——地址可达 + 凭据正确 + 确为 MCP 实例，三者同时成立
 *      才算「控制权证明」（不给人工审批留口子，也不接受自述 merchant_id）；
 *   3) 令牌加密落库（`instance:<merchant_id>`），注册表记录 merchant_id → 地址。
 *
 * 令牌只在网关托管的页面里提交，**永不进入对话/模型上下文**（设计 §3.1）；
 * 本模块不打印令牌，错误信息也只含状态码与地址。
 */

import type { DatabaseSync } from "node:sqlite";

import type { MerchantCredentialStore } from "./credential-vault.js";
import {
  canonicalInstanceUrl,
  INSTANCE_CREDENTIAL_KIND,
  TenantBackendError,
} from "./tenant-registry.js";
import { PRODUCT_VERSION } from "../product-cli.js";

const REGISTRATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_instance_registrations (
  merchant_id TEXT PRIMARY KEY,
  mcp_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** 实例内部凭据不设自动过期：生命周期由「解绑」「重新绑定覆盖」结束。 */
export const INSTANCE_CREDENTIAL_NO_EXPIRY = "9999-12-31T23:59:59.999Z";

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BYTES = 512 * 1024;

export interface InstanceRegistration {
  merchantId: string;
  mcpUrl: string;
  createdAt: string;
  updatedAt: string;
}

function credentialKey(merchantId: string): string {
  return `${INSTANCE_CREDENTIAL_KIND}:${merchantId}`;
}

/** 实例注册表（地址部分；凭据部分在加密保管库）。 */
export class InstanceRegistrationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now?: () => string }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec(REGISTRATION_SCHEMA);
  }

  get(merchantId: string): InstanceRegistration | undefined {
    const row = this.db
      .prepare(
        "SELECT merchant_id, mcp_url, created_at, updated_at FROM gateway_instance_registrations WHERE merchant_id = ?",
      )
      .get(merchantId) as
      { merchant_id: string; mcp_url: string; created_at: string; updated_at: string } | undefined;
    if (row === undefined) return undefined;
    return {
      merchantId: row.merchant_id,
      mcpUrl: row.mcp_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsert(merchantId: string, mcpUrl: string): InstanceRegistration {
    const now = this.now();
    const existing = this.get(merchantId);
    this.db
      .prepare(
        `INSERT INTO gateway_instance_registrations(merchant_id, mcp_url, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(merchant_id) DO UPDATE SET
           mcp_url = excluded.mcp_url,
           updated_at = excluded.updated_at`,
      )
      .run(merchantId, mcpUrl, existing?.createdAt ?? now, now);
    return this.get(merchantId) as InstanceRegistration;
  }

  delete(merchantId: string): boolean {
    const cursor = this.db
      .prepare("DELETE FROM gateway_instance_registrations WHERE merchant_id = ?")
      .run(merchantId);
    return cursor.changes > 0;
  }
}

/**
 * 绑定流程需要的注册表能力（结构化接口，便于测试注入）：真实实现是
 * `InstanceRegistrationStore`。
 */
export interface InstanceRegistrationWriter {
  get(merchantId: string): InstanceRegistration | undefined;
  upsert(merchantId: string, mcpUrl: string): InstanceRegistration;
  delete(merchantId: string): boolean;
}

export interface InstanceBindingDeps {
  registrations: InstanceRegistrationWriter;
  credentials: MerchantCredentialStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProbeResult {
  mcpUrl: string;
  toolCount: number;
}

async function rpcCall(
  mcpUrl: string,
  token: string,
  method: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let body: unknown;
  try {
    try {
      response = await fetchImpl(mcpUrl, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "user-agent": `kiwi-merchant-entry/${PRODUCT_VERSION}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      throw new TenantBackendError(
        name === "AbortError"
          ? `实例探活超时（${timeoutMs}ms）：${mcpUrl}`
          : `实例不可达：${mcpUrl}`,
        "invalid_config",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new TenantBackendError("实例返回重定向：拒绝（防凭据转发）", "invalid_config");
    }
    if (response.status === 401 || response.status === 403) {
      throw new TenantBackendError("实例拒绝了该内部令牌（401/403）", "invalid_config");
    }
    if (!response.ok) {
      throw new TenantBackendError(`实例返回 HTTP ${response.status}`, "invalid_config");
    }
    const text = await response.text();
    if (text.length > PROBE_MAX_BYTES) {
      throw new TenantBackendError("实例响应体过大：拒绝", "invalid_config");
    }
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new TenantBackendError("实例响应不是合法 JSON（不是 MCP 端点？）", "invalid_config");
    }
  } finally {
    clearTimeout(timer);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TenantBackendError("实例响应结构非法", "invalid_config");
  }
  const record = body as Record<string, unknown>;
  if (record.error !== undefined) {
    throw new TenantBackendError(
      `实例返回 JSON-RPC 错误：${
        typeof record.error === "object" && record.error !== null
          ? String((record.error as { message?: unknown }).message ?? "unknown")
          : String(record.error)
      }`,
      "invalid_config",
    );
  }
  return record;
}

/**
 * 探活：地址可达 + 凭据正确 + 确为 MCP 实例（initialize 与 tools/list 都成功）。
 * 失败一律抛 TenantBackendError，调用方据此拒绝绑定且不写任何状态。
 */
export async function probeInstance(
  mcpUrl: string,
  token: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const url = canonicalInstanceUrl(mcpUrl);
  if (typeof token !== "string" || token.trim() === "") {
    throw new TenantBackendError("实例内部令牌不能为空", "invalid_config");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  await rpcCall(url, token, "initialize", fetchImpl, timeoutMs);
  const listed = await rpcCall(url, token, "tools/list", fetchImpl, timeoutMs);
  const result = listed.result;
  const tools =
    result !== null &&
    typeof result === "object" &&
    Array.isArray((result as { tools?: unknown }).tools)
      ? ((result as { tools: unknown[] }).tools as unknown[])
      : undefined;
  if (tools === undefined) {
    throw new TenantBackendError(
      "实例未返回 tools/list 结果（不是支持工具的 MCP 实例？）",
      "invalid_config",
    );
  }
  return { mcpUrl: url, toolCount: tools.length };
}

/** 绑定：校验 → 探活 → 加密存凭据 → 记录地址。任一步失败都不留半成品状态。 */
export async function bindInstance(
  deps: InstanceBindingDeps,
  input: { merchantId: string; mcpUrl: string; token: string },
  options: { probe?: (mcpUrl: string, token: string) => Promise<ProbeResult> } = {},
): Promise<ProbeResult> {
  if (input.merchantId.trim() === "") {
    throw new TenantBackendError("缺少商家身份", "invalid_config");
  }
  // URL 策略在这里先过一遍（不依赖探活实现）：注入探针时同样必须校验，
  // 存储的也永远是规范化后的地址。
  const canonical = canonicalInstanceUrl(input.mcpUrl);
  const prober =
    options.probe ??
    ((mcpUrl: string, token: string) =>
      probeInstance(mcpUrl, token, {
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      }));
  const probe = await prober(canonical, input.token);
  deps.credentials.put(credentialKey(input.merchantId), input.token, INSTANCE_CREDENTIAL_NO_EXPIRY);
  try {
    deps.registrations.upsert(input.merchantId, canonical);
  } catch (err) {
    // 注册写入失败则撤销刚写入的凭据，避免「有凭据无路由」的半绑定。
    deps.credentials.delete(credentialKey(input.merchantId));
    throw err;
  }
  return probe;
}

/** 解绑：删除地址与凭据（目录资料、关注关系不受影响）。 */
export function unbindInstance(
  deps: Pick<InstanceBindingDeps, "registrations" | "credentials">,
  merchantId: string,
): boolean {
  const removed = deps.registrations.delete(merchantId);
  deps.credentials.delete(credentialKey(merchantId));
  return removed;
}
