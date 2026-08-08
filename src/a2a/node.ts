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
 * A2A 节点生命周期（裸 `kiwi` 自动启动用）：
 *
 * 一个进程既是对话 agent（chat kernel）又是 A2A 节点（可被发现/磋商）。
 *   - merchant 角色：A2AServer + 生产 KNP merchant handler，启动时自动注册进
 *     kiwi-catalog（buyer 据此发现）；
 *   - buyer 角色：A2AServer + 默认 handler（可被发现，不注册——本流程由 buyer 发起）。
 *
 * 端口按角色：merchant→9000、buyer→9001（KIWI_A2A_PORT 覆盖）；占用则
 * pickFreePort 自动换。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProfile } from "../config/profile.js";
import { A2AServer } from "./server/index.js";
import { defaultHandler } from "./server/handler.js";
import { createMerchantHandler } from "./server/merchant-handler.js";
import { LedgerStore } from "../negotiation/ledger/index.js";
import { IdempotencyStore } from "../negotiation/idempotency/index.js";
import { pickFreePort } from "../supervisor/stack-config.js";
import { registerCatalogAgent } from "../discovery/catalog-source/register.js";
import { HttpMerchantClient } from "../agent/merchant/merchant-client.js";
import { ProfileCredentialBroker } from "../agent/merchant/credential-broker.js";
import type { MerchantProductSource } from "./server/merchant-handler.js";

export interface A2aNodeOptions {
  profile: AgentProfile;
  /** agent catalog base URL（merchant 自动注册用）。 */
  catalog?: string;
  /** 首选端口（缺省按角色：merchant 9000 / buyer 9001）。占用则自动换。 */
  preferredPort?: number;
  /** KIWI_CATALOG_OWNER_TOKEN_SECRET（merchant 注册绑定 owner 语义）。 */
  ownerTokenSecret?: string;
}

export interface A2aNodeHandle {
  role: "buyer" | "merchant";
  /** 节点 base URL。 */
  url: string;
  /** Agent Card well-known URL。 */
  agentCardUrl: string;
  /** 注册进 catalog 的 catalog_agent_id（merchant 角色且有 catalog 时）。 */
  catalogAgentId?: string;
  stop(): Promise<void>;
}

/** 单调递增时钟：同内容事件在同一毫秒会触发 ledger 内容去重。 */
function monotonicNow(): () => string {
  let tick = 0;
  const base = Date.parse("2026-08-07T00:00:00.000Z");
  return () => {
    const t = new Date(base + tick);
    tick += 1;
    return t.toISOString();
  };
}

/** 优先监听 preferredPort；被占用则换空闲端口。 */
async function listenPort(preferred: number): Promise<{ port: number; url: string }> {
  // 尝试 preferred：失败（EADDRINUSE）则 pickFreePort。
  const { createServer } = await import("node:net");
  const tryListen = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => {
        s.close();
        resolve(true);
      });
    });
  // preferred <= 0（含显式 0 / NaN）不尝试：tryListen(0) 会返回"成功"并把
  // port=0 带进 url（http://127.0.0.1:0），随后 server.listen(0) 换随机端口
  // 但 holder.baseUrl 仍是无效端口 0——节点 URL 全部指向空。直接 pickFreePort。
  const port = preferred > 0 && (await tryListen(preferred)) ? preferred : await pickFreePort();
  return { port, url: `http://127.0.0.1:${port}` };
}

/**
 * 构建真实商品源：读 shopping-cli（开放商品层）的价目。URL 来自
 * `KIWI_COMMERCE_URL` 覆盖或 profile.commerce.base_url；/products/{sku} 是
 * 公开只读端点（无需 token），shopping-cli 自身可接 ERP/本地商品表。
 */
function buildProductSource(profile: AgentProfile): MerchantProductSource {
  const commerceUrl = process.env.KIWI_COMMERCE_URL ?? profile.commerce.base_url;
  const client = new HttpMerchantClient(commerceUrl, new ProfileCredentialBroker(profile));
  return {
    getProduct: async (sku) => {
      const product = await client.getProduct(sku);
      return { price: product.price, currency: product.currency };
    },
  };
}

/** 启动一个 A2A 节点（按 profile 角色）。 */
export async function startA2aNode(options: A2aNodeOptions): Promise<A2aNodeHandle> {
  const { profile } = options;
  const role = profile.role;
  const preferred =
    options.preferredPort ?? (Number(process.env.KIWI_A2A_PORT ?? "") || (role === "merchant" ? 9000 : 9001));
  const { port, url } = await listenPort(preferred);
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-node-"));
  const now = monotonicNow();
  const ledger = new LedgerStore({ dir, now });
  const idempotency = new IdempotencyStore({ dir, now });

  const handler =
    role === "merchant"
      ? createMerchantHandler({
          ledger,
          now,
          sender: profile.agent_id,
          counterparty: "buyer:*",
          productSource: buildProductSource(profile),
        })
      : defaultHandler();

  const holder = { baseUrl: url };
  const server = new A2AServer({
    // A2AServerOptions.card 是 AgentCardConfigProvider：返回 config，server 内部再 buildAgentCard。
    // name 用干净显示名，不掺 agent_id（形如 agent:token，会被 card secret 扫描器判为 card_has_secret）。
    card: () => ({
      name: role === "merchant" ? "Kiwi A2A Merchant" : "Kiwi A2A Buyer",
      description: "Kiwi A2A node",
      providerOrganization: "Kiwi",
      version: "1.0.0",
      baseUrl: holder.baseUrl,
      a2aPath: "/",
    }),
    ledger,
    idempotency,
    handler,
    now,
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve()));
  holder.baseUrl = url;
  const agentCardUrl = `${url}/.well-known/agent-card.json`;

  // merchant 角色：自动注册进 catalog（buyer 据此发现）。
  let catalogAgentId: string | undefined;
  if (role === "merchant" && options.catalog !== undefined) {
    const safeAgentId = profile.agent_id.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const domain =
      process.env.KIWI_CATALOG_DOMAIN ?? `merchant-${safeAgentId}.local`;
    try {
      const reg = await registerCatalogAgent({
        catalogBaseUrl: options.catalog,
        domain,
        agentCardUrl,
        ucpProfileUrl: `${url}/.well-known/ucp`,
        merchantId: profile.agent_id,
        ownerTokenSecret: options.ownerTokenSecret,
      });
      catalogAgentId = reg.catalogAgentId;
    } catch {
      // 注册失败不阻断节点：buyer 侧仍可经 direct URL 磋商。
      catalogAgentId = undefined;
    }
  }

  return {
    role,
    url,
    agentCardUrl,
    catalogAgentId,
    async stop(): Promise<void> {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
