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

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createMonotonicClock } from "./clock.js";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProfile } from "../config/profile.js";
import type { AuthVerifier } from "./server/types.js";
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
  /** 持久状态目录（审查 BUG-03）：提供时 Ledger/幂等/owner 锁落该目录，
   *   stop() 不删除——重启后幂等、终态、已发 conditional offer 可恢复；
   *   缺省回退临时目录（demo/测试形态，stop 时删除）。 */
  dataDir?: string;
  /** KIWI_CATALOG_OWNER_TOKEN_SECRET（merchant 注册绑定 owner 语义，legacy HMAC 派生）。 */
  ownerTokenSecret?: string;
  /** 商家自己的随机 owner token（v12+ 双路径；平台 secret 不落商家服务器）。 */
  ownerToken?: string;
  /**
   * 对外广告的 base URL（如 `https://veyquo.com`）——节点**仍监听
   * 127.0.0.1**（Caddy 等反向代理把公网流量转到回环），但 Agent Card /
   * UCP / catalog 注册都广告该公网地址。缺省 `KIWI_A2A_PUBLIC_URL` 环境
   * 变量；两者都不设则广告回环地址（本地形态）。
   */
  publicBaseUrl?: string;
  /** 入站认证验证器（审查 BUG-02）：广告地址非 loopback 时**必须**提供——
   *  缺省 LoopbackOnlyAuthVerifier 只信 socket 来源，反代从 127.0.0.1
   *  连接时外部请求在应用层就是 loopback 并被认证通过。未配置则启动失败。 */
  authVerifier?: AuthVerifier;
}

export interface A2aNodeHandle {
  role: "buyer" | "merchant";
  /** 实际监听的回环 base URL（本机控制/测试用）。 */
  url: string;
  /** 对外广告的 base URL（publicBaseUrl 覆盖时是公网 HTTPS，否则同 url）。 */
  advertisedUrl: string;
  /** Agent Card well-known URL（对外广告地址）。 */
  agentCardUrl: string;
  /** 注册进 catalog 的 catalog_agent_id（merchant 角色且有 catalog 时）。 */
  catalogAgentId?: string;
  stop(): Promise<void>;
}

/** 现实单调时钟（审查 BUG-01）：墙钟 + 同进程严格单调；生产不得用固定
 * 日期基准（第三方会收到历史时间戳/已过期报价，重启还会回退历史）。 */
const monotonicNow = createMonotonicClock;

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

/**
 * 解析对外广告的 base URL：显式 `publicBaseUrl`/`KIWI_A2A_PUBLIC_URL` 优先，
 * 缺省回退本机回环。广告地址必须是 http(s) URL（fail-closed——错误的公网
 * 配置在启动即失败，不带着错误身份对外服务）。
 */
function resolveAdvertisedBase(publicBaseUrl: string | undefined, loopbackUrl: string): string {
  const raw = (publicBaseUrl ?? process.env.KIWI_A2A_PUBLIC_URL ?? "").trim();
  if (raw === "") return loopbackUrl;
  const normalized = raw.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(
      `KIWI_A2A_PUBLIC_URL 不是合法 URL: ${raw!}（应为 https://<host> 形式）`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`KIWI_A2A_PUBLIC_URL 必须是 http(s) URL: ${raw}`);
  }
  return normalized;
}

/** 广告地址是否 loopback（本地形态）。 */
function isLoopbackAdvertised(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

/** 启动一个 A2A 节点（按 profile 角色）。 */
export async function startA2aNode(options: A2aNodeOptions): Promise<A2aNodeHandle> {
  const { profile } = options;
  const role = profile.role;
  const preferred =
    options.preferredPort ?? (Number(process.env.KIWI_A2A_PORT ?? "") || (role === "merchant" ? 9000 : 9001));
  const { port, url } = await listenPort(preferred);
  const advertisedBase = resolveAdvertisedBase(options.publicBaseUrl, url);
  // 审查 BUG-02：公网广告形态必须显式认证——LoopbackOnlyAuthVerifier 只信
  // socket 来源，反代从 127.0.0.1 连接时外部请求在应用层就是 loopback。
  // 未配置验证器则启动失败（fail-closed），不带着错误身份对外服务。
  if (!isLoopbackAdvertised(advertisedBase) && options.authVerifier === undefined) {
    throw new Error(
      `广告地址 ${advertisedBase} 不是 loopback：必须配置 authVerifier` +
        `（HTTP Message Signature 验证器或明确的可审计代理认证契约），` +
        `否则反向代理连接会被误当本机可信`,
    );
  }
  // 审查 BUG-03：持久形态（dataDir）——Ledger/幂等落 <dataDir>/a2a/，
  // stop 不删除；临时形态（demo/测试）维持 mkdtemp + stop 删除。
  const isEphemeral = options.dataDir === undefined;
  const dir = isEphemeral
    ? mkdtempSync(path.join(tmpdir(), "kiwi-a2a-node-"))
    : (() => {
        const stateDir = path.join(options.dataDir!, "a2a");
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        return stateDir;
      })();
  // 单 owner 协调（审查 BUG-03）：同一状态目录只允许一个节点实例——exclusive
  // lock 文件 + PID；崩溃残留（PID 已死）自动接管，存活实例则启动失败。
  let releaseOwnerLock: (() => void) | undefined;
  if (!isEphemeral) {
    const lockPath = path.join(dir, "owner.lock");
    const stealIfStale = (): void => {
      if (!existsSync(lockPath)) return;
      const pidText = readFileSync(lockPath, "utf-8").trim();
      const pid = Number(pidText);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // 存活 → 不接管
          throw new Error(
            `A2A 状态目录已被其他进程占用（pid ${pid}）：${dir}——请先停止该进程或换 --data-dir`,
          );
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("A2A 状态目录")) throw err;
          // ESRCH：进程已死，残留锁可接管
        }
      }
      unlinkSync(lockPath);
    };
    stealIfStale();
    const fd = openSync(lockPath, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    releaseOwnerLock = (): void => {
      try {
        unlinkSync(lockPath);
      } catch {
        // 已不存在/无权限：忽略
      }
    };
    process.once("exit", releaseOwnerLock);
  }
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

  const holder = { baseUrl: advertisedBase };
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
    // 发布 UCP Profile（/.well-known/ucp）：注册广告了 ucp_profile_url，
    // 端点就必须真实可拉——否则 catalog 验证的 profile 阶段拉 UCP 404 →
    // freshness=unreachable → buyer 发现被 BLOCKED 列表挡掉。
    ucp: true,
    ledger,
    idempotency,
    handler,
    now,
    ...(options.authVerifier !== undefined ? { authVerifier: options.authVerifier } : {}),
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve()));
  holder.baseUrl = advertisedBase;
  const agentCardUrl = `${advertisedBase}/.well-known/agent-card.json`;

  // merchant 角色：自动注册进 catalog（buyer 据此发现）。
  let catalogAgentId: string | undefined;
  if (role === "merchant" && options.catalog !== undefined) {
    const safeAgentId = profile.agent_id.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    // 注册域名：显式 KIWI_CATALOG_DOMAIN 优先；有公网广告地址则取其
    // hostname（域名就是对外身份，catalog 据此做 well-known 域控制验证）；
    // 否则本地形态回退占位域名。
    const domain =
      process.env.KIWI_CATALOG_DOMAIN ??
      (advertisedBase !== url ? new URL(advertisedBase).hostname : `merchant-${safeAgentId}.local`);
    try {
      const reg = await registerCatalogAgent({
        catalogBaseUrl: options.catalog,
        domain,
        agentCardUrl,
        ucpProfileUrl: `${advertisedBase}/.well-known/ucp`,
        merchantId: profile.agent_id,
        ownerToken: options.ownerToken,
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
    advertisedUrl: advertisedBase,
    agentCardUrl,
    catalogAgentId,
    async stop(): Promise<void> {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      // 审查 BUG-03：持久形态不删除状态目录（重启恢复依赖它）；临时形态
      // （demo/测试）维持删除。owner 锁总是释放。
      releaseOwnerLock?.();
      if (isEphemeral) rmSync(dir, { recursive: true, force: true });
    },
  };
}
