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
import { resolveSecret } from "../config/profile.js";
import {
  DeepSeekDecisionBackend,
  MockDecisionBackend,
  type MerchantDecisionBackend,
} from "../merchant/decision-backend.js";
import type { AuthVerifier } from "./server/types.js";
import {
  A2AServer,
  LoopbackOnlyAuthVerifier,
  NoneAuthVerifier,
  StaticBearerAuthVerifier,
  type ThrottleOptions,
} from "./server/index.js";
import { HttpMessageSignatureVerifier, InMemoryNonceStore } from "../trust/identity/index.js";
import {
  loadA2aTrustedKeys,
  loadOrCreateA2aSigningIdentity,
  resolveA2aSignatureResolver,
  type A2aSigningIdentity,
} from "./signing-key.js";
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
   * merchant 必须成功注册进 catalog 才启动（fail-closed）。审查 K-M11：此前
   * 注册失败被空 catch 静默吞掉，merchant 静默不在 catalog 且无任何日志。
   * 缺省读 `KIWI_REQUIRE_CATALOG_REGISTRATION=1`；两者都不设则记录日志后继续
   * （buyer 仍可经 direct URL 磋商）。
   */
  requireCatalogRegistration?: boolean;
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
  /** 节点签名身份（Issue 16 B / KIWI_A2A_AUTH=signature 时存在）。 */
  signingIdentity?: A2aSigningIdentity;
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
  const broker = new ProfileCredentialBroker(profile);
  // 审查 X-M1：handoff_destination 与精确 stock 是商家私有字段，公开端点匿名
  // 一律剥除——未配置 catalog 凭据时真实报价路径只能拿到 availability_hint，
  // KTH 成交入口静默不可用。显式告警（而非无信号降级），文档见 README。
  if (!broker.has("catalog")) {
    process.stderr.write(
      `⚠️ [kiwi] merchant 未配置 catalog 凭据（commerce.credentials.catalog.token_env）：` +
        `商品源将匿名读取，handoff_destination（KTH 成交入口）与精确库存不可用，` +
        `仅得到 availability_hint。要完整 handoff 能力请配置 catalog token。\n`,
    );
  }
  const client = new HttpMerchantClient(commerceUrl, broker);
  return {
    getProduct: async (sku) => {
      const product = await client.getProduct(sku);
      return {
        price: product.price,
        currency: product.currency,
        ...(product.handoff_destination !== undefined
          ? { handoff_destination: product.handoff_destination }
          : {}),
      };
    },
  };
}

/**
 * 解析对外广告的 base URL：显式 `publicBaseUrl`/`KIWI_A2A_PUBLIC_URL` 优先，
 * 缺省回退本机回环（自动回环 URL 允许 http）。
 *
 * 审查 P1-08：显式广告地址只接受 **HTTPS origin**——拒绝远程（非回环）
 * http、userinfo、path、query、fragment（`https://<host>` 唯一合法形态）。
 * 广告地址是 Agent Card / UCP / catalog 注册的对外身份，携带路径或凭据会
 * 污染 well-known URL 构造与域控制验证。fail-closed：错误公网配置在启动即
 * 失败，不带着错误身份对外服务。
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
  if (parsed.protocol !== "https:") {
    throw new Error(`KIWI_A2A_PUBLIC_URL 必须是 https URL（公网广告不接受 http）: ${raw}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`KIWI_A2A_PUBLIC_URL 不得内嵌凭据（userinfo）: ${raw}`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`KIWI_A2A_PUBLIC_URL 不得包含 query/fragment（应为 https://<host>）: ${raw}`);
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new Error(`KIWI_A2A_PUBLIC_URL 不得包含路径（应为 https://<host> 形式）: ${raw}`);
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

/** 从 KIWI_A2A_AUTH env 构造 authVerifier（公网广告形态的认证边界，审查 BUG-02）。
 *
 * - ``loopback`` → LoopbackOnlyAuthVerifier：只信 loopback socket 来源（Caddy
 *   反代从 127.0.0.1 连接时的应用层信任边界，可审计的代理认证契约）；
 * - ``none`` → NoneAuthVerifier：总是放行（显式可信网络/测试）；
 * - ``bearer:<token>`` → StaticBearerAuthVerifier：校验 Authorization Bearer。
 * 未配置 → undefined（公网广告形态下守卫拒绝启动，fail-closed）。
 */
interface AuthFromEnvContext {
  /** 签名模式节点密钥目录（dataDir 或临时）。 */
  signingKeyDir: string;
  /** 签名模式 keyid（公网用 advertised origin，否则 role:agent_id）。 */
  signingKeyId: string;
  role: AgentProfile["role"];
  advertisedBase: string;
}

/**
 * 从 KIWI_A2A_AUTH 构造入站验证器（公网广告形态的认证边界，审查 BUG-02）。
 * 模式：
 * - ``loopback`` → LoopbackOnlyAuthVerifier；
 * - ``none`` → NoneAuthVerifier（显式可信网络/测试）；
 * - ``bearer:<token>`` → StaticBearerAuthVerifier；
 * - ``signature`` → HTTP Message Signature（RFC 9421，Issue 16 B）：
 *   节点自持 Ed25519 密钥对，验签方按 keyid→公钥 resolver；**匿名请求按 T0
 *   放行**（无预共享密钥的开放互操作：任何 kiwi buyer 可与任何 kiwi merchant
 *   沟通；签名请求获更高信任）。
 */
function authVerifierFromEnv(ctx: AuthFromEnvContext): AuthVerifier | undefined {
  const raw = (process.env.KIWI_A2A_AUTH ?? "").trim();
  if (raw === "") return undefined;
  if (raw === "loopback") return new LoopbackOnlyAuthVerifier();
  if (raw === "none") return new NoneAuthVerifier();
  if (raw === "signature") {
    const identity = loadOrCreateA2aSigningIdentity(ctx.signingKeyDir, ctx.signingKeyId);
    // Issue 16 B：trusted-keys 注册表（<dataDir>/a2a-trusted-keys.json）——
    // 运营者把可信对端（buyer）的公钥放进来，其签名请求即被验签并提升身份。
    let trustedKeys: ReturnType<typeof loadA2aTrustedKeys> = [];
    const trustedFile = path.join(ctx.signingKeyDir, "a2a-trusted-keys.json");
    if (existsSync(trustedFile)) {
      trustedKeys = loadA2aTrustedKeys(trustedFile);
    }
    const advertised = new URL(ctx.advertisedBase);
    return new HttpMessageSignatureVerifier({
      resolver: resolveA2aSignatureResolver(identity, trustedKeys),
      scheme: advertised.protocol === "https:" ? "https" : "http",
      expectedAuthority: advertised.hostname,
      // 设计意图：匿名 T0 放行，签名请求更高信任——不阻塞任何 kiwi buyer。
      anonymousTrustLevel: "T0",
      anonymousIdentity: "anonymous",
      // 审查 M2：此前未接 nonceStore——签名请求的 nonce 永不被校验，重放保护
      // 失效（JWS/nonce 机制是死代码）。接入内存 nonce 存储后，T1+ 键可强制 nonce。
      nonceStore: new InMemoryNonceStore(),
    });
  }
  if (raw.startsWith("bearer:")) {
    const token = raw.slice("bearer:".length).trim();
    if (token === "") throw new Error("KIWI_A2A_AUTH=bearer:<token> 需要非空 token");
    return new StaticBearerAuthVerifier(token);
  }
  throw new Error(
    `KIWI_A2A_AUTH 未知模式: ${raw}（可选 loopback | none | bearer:<token> | signature）`,
  );
}

/**
 * 解析 merchant A2A 反滥用限流（§31）：
 * - 未设置 / "0" / "false" / "off" → 不限流（undefined）；
 * - "1" / "true" / "on" → 默认档位表（60s 窗口；匿名来源限额自动缩窄 0.5）；
 * - 其它 → 按 JSON 解析为 ThrottleOptions 覆盖（如
 *   `{"windowMs":60000,"tiers":{"T0":{"identityRequestsPerWindow":60}}}`）。
 */
export function resolveA2aThrottle(raw = process.env.KIWI_A2A_THROTTLE ?? ""): ThrottleOptions | undefined {
  const v = raw.trim();
  if (v === "" || v === "0" || v === "false" || v === "off") return undefined;
  if (v === "1" || v === "true" || v === "on") return {};
  try {
    const parsed = JSON.parse(v) as ThrottleOptions;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("ThrottleOptions 必须是对象");
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `KIWI_A2A_THROTTLE 非法: ${v}（可选 "1"/"true"/"on" 用默认档位，或 JSON ThrottleOptions）——${err instanceof Error ? err.message : String(err)}`,
    );
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
  // authVerifier 来源：options 直传优先，否则 KIWI_A2A_AUTH env
  // （loopback | none | bearer:<token> | signature）。
  // Issue 16 B：signature 模式节点自持 Ed25519 密钥对。签名目录**单一来源**：
  // 持久 dataDir 优先（密钥/trusted-keys/出站 env 同源）；临时用
  // <tmpdir>/kiwi-a2a-signing-<agent_id>（demo/测试，重启换钥可接受）。
  const signatureMode = (process.env.KIWI_A2A_AUTH ?? "").trim() === "signature";
  const signingKeyDir = options.dataDir ?? path.join(tmpdir(), `kiwi-a2a-signing-${profile.agent_id}`);
  const signingIdentity: A2aSigningIdentity | undefined = signatureMode
    ? loadOrCreateA2aSigningIdentity(
        signingKeyDir,
        !isLoopbackAdvertised(advertisedBase)
          ? new URL(advertisedBase).origin
          : `${role}:${profile.agent_id}`,
      )
    : undefined;
  const authVerifier = options.authVerifier ?? authVerifierFromEnv({
    signingKeyDir,
    signingKeyId:
      signingIdentity?.keyid ?? (isLoopbackAdvertised(advertisedBase) ? `${role}:${profile.agent_id}` : new URL(advertisedBase).origin),
    role,
    advertisedBase,
  });
  // 出站签名（Issue 16 B）：节点自持密钥 → 出站 A2A 请求自动签名。
  // A2ADirectChannel 的 env 回退读 KIWI_A2A_SIGNING_KEY_FILE；这里把节点密钥
  // 文件指向自身（缺省不覆盖显式配置），使本进程的 outbound 都用同一身份。
  if (signingIdentity !== undefined && (process.env.KIWI_A2A_SIGNING_KEY_FILE ?? "").trim() === "") {
    process.env.KIWI_A2A_SIGNING_KEY_FILE = path.join(signingKeyDir, "a2a-signing-key.json");
  }
  // 反滥用限流（§31）：KIWI_A2A_THROTTLE 非空即启用（默认档位表 / JSON 覆盖）。
  const a2aThrottle = resolveA2aThrottle();
  if (!isLoopbackAdvertised(advertisedBase) && authVerifier === undefined) {
    throw new Error(
      `广告地址 ${advertisedBase} 不是 loopback：必须配置 authVerifier` +
        `（KIWI_A2A_AUTH=loopback|none|bearer:<token>，或 HTTP Message Signature 验证器），` +
        `否则反向代理连接会被误当本机可信`,
    );
  }
  // 审查 P2-E：loopback 模式 + 公网广告地址是部署脚枪——节点只绑定
  // 127.0.0.1，经反代转发的公网流量在应用层全是 loopback 一律放行，认证
  // 形同虚设（功能等价 none）。不改默认行为（反代自己做强认证时 loopback
  // 仍是合法的代理即边界契约），但醒目告警：认证责任全在反代。
  if (!isLoopbackAdvertised(advertisedBase) && authVerifier?.name === "loopback-only") {
    process.stderr.write(
      `⚠️ [kiwi] 广告地址 ${advertisedBase} 是公网地址，但 KIWI_A2A_AUTH=loopback：` +
        `节点只校验 socket 来源，经反向代理转发的公网请求在应用层全部是 loopback 一律放行，` +
        `等价于无应用层认证——认证责任完全在反代（反代必须自己做强认证并把它当作信任边界）。` +
        `公网节点建议使用 KIWI_A2A_AUTH=bearer:<token> 或 HTTP Message Signature 验证器。\n`,
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

  /** 按 profile.decision 装配 merchant 推理后端（DeepSeek Harness 运行时插件）。 */
  const buildDecisionBackend = (): MerchantDecisionBackend | undefined => {
    const cfg = profile.decision;
    if (cfg === undefined || cfg.enabled === false) return undefined;
    switch (cfg.backend) {
      case "deepseek":
        // api_key_env 惰性解析：profile 只存 env 名；请求时 resolveSecret，
        // 未设置 → 后端 fail-safe 回落确定性（非静默配置错误）。
        return new DeepSeekDecisionBackend({
          apiKey: () => resolveSecret(profile.model.api_key_env ?? "DEEPSEEK_API_KEY", "decision backend"),
          model: profile.model.model,
        });
      case "mock":
        return new MockDecisionBackend();
      case "deterministic":
        return undefined;
    }
  };

  const handler =
    role === "merchant"
      ? createMerchantHandler({
          ledger,
          now,
          sender: profile.agent_id,
          counterparty: "buyer:*",
          productSource: buildProductSource(profile),
          allowDemoPriceFallback: profile.commerce.allow_demo_price_fallback ?? false,
          merchantPolicy: profile.merchant_policy,
          decisionBackend: buildDecisionBackend(),
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
      // Issue 16 B：签名模式发布节点公开签名密钥（非 secret），对端据此验签。
      ...(signingIdentity !== undefined
        ? {
            securityScheme: {
              name: "kiwi-signature",
              type: "kiwi-http-message-signature",
              keyid: signingIdentity.keyid,
              publicKeyPem: signingIdentity.publicKeyPem,
              algorithm: signingIdentity.algorithm,
            },
          }
        : {}),
    }),
    // 发布 UCP Profile（/.well-known/ucp）：注册广告了 ucp_profile_url，
    // 端点就必须真实可拉——否则 catalog 验证的 profile 阶段拉 UCP 404 →
    // freshness=unreachable → buyer 发现被 BLOCKED 列表挡掉。
    ucp: true,
    ledger,
    idempotency,
    handler,
    now,
    ...(authVerifier !== undefined ? { authVerifier } : {}),
    ...(a2aThrottle !== undefined ? { throttle: a2aThrottle } : {}),
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
    const requireRegistration =
      options.requireCatalogRegistration ?? process.env.KIWI_REQUIRE_CATALOG_REGISTRATION === "1";
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
    } catch (err) {
      // 审查 K-M11：注册失败必须可见——此前空 catch 静默吞掉，merchant 静默
      // 不在 catalog（buyer 只能 direct URL）且无任何日志。默认记录日志后继续
      // （buyer 仍可经 direct URL 磋商）；KIWI_REQUIRE_CATALOG_REGISTRATION=1
      // 或显式 requireCatalogRegistration 时 fail-closed（启动失败）。
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `⚠️ [kiwi] merchant catalog 注册失败（${detail}）——` +
          (requireRegistration
            ? "KIWI_REQUIRE_CATALOG_REGISTRATION 已开启，节点启动失败（fail-closed）。"
            : "merchant 不会出现在 catalog，buyer 只能经 direct URL 磋商。"),
      );
      if (requireRegistration) {
        // fail-closed：注册失败即启动失败——先清理已创建的 server/锁/临时目录
        // （镜像 stop()），不留下监听中的孤儿节点。
        httpServer.closeAllConnections?.();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        releaseOwnerLock?.();
        if (isEphemeral) rmSync(dir, { recursive: true, force: true });
        throw err;
      }
      catalogAgentId = undefined;
    }
  }

  return {
    role,
    url,
    advertisedUrl: advertisedBase,
    agentCardUrl,
    catalogAgentId,
    ...(signingIdentity !== undefined ? { signingIdentity } : {}),
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
