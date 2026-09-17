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
 * `kiwi merchant gateway serve` —— 商家连接器（「Kiwi 商家运营」）的远程 MCP 入口。
 *
 * merchant-buddy 第 1 版设计 §3.2 / 商家连接器发布计划 §2：买方连接器
 * （`kiwi-sourcing`，本地 stdio）由本命令之外的路径承载；本进程只服务商家侧，
 * 服务端连接共享 `kiwi-catalog`，第 0 版提供公开资料能力，第 1 版按服务端
 * 注册表路由到商家自托管实例。
 *
 * 部署形态（两种，均要求公网为 HTTPS）：
 *
 *   1) 反向代理终止 TLS（推荐）：本进程 `--host 127.0.0.1`（默认），
 *      `--public-url https://…` 指向代理对外地址；
 *   2) 本进程直接终止 TLS：`--tls-cert/--tls-key`（可配合非 loopback 监听）。
 *
 * 监听非 loopback 且既无 TLS 材料又未显式 `--trusted-proxy` 时**拒绝启动**
 * （fail-closed）；不做“默认相信前面有代理”的推断。
 *
 * 凭据分工（互不通用，详见启动摘要）：
 *   - **用户 OAuth token**：WorkBuddy ↔ 入口。授权码 + PKCE 签发，入口只存摘要；
 *   - **connector token**（`--connector-token-env`）：入口 → 目录的机器凭据，
 *     仅用于创建/兑换一次性身份授权请求，**不授予任何商家数据访问**；
 *   - **商家目录凭据 `cmt_…`**：入口 → 目录的商家作用域凭据（读写该商家公开
 *     资料；发布仍须商家在门户确认）；由兑换签发，加密保管；
 *   - **实例内部凭据**（第 1 版）：入口 → 商家自托管 MCP 实例；同样加密保管；
 *   - **凭据加密密钥**（`--credential-key-env`）：仅本进程使用，不落库、不下发。
 *
 * 缺少加密密钥时**不启用**依赖加密存储的功能（目录工具与实例路由），
 * 但入口本身仍可启动（连接流程与健康检查可用）——第 0 版注册/发布不会因
 * 尚未配对实例或缺少实例凭据而被阻塞。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  expectedCallbackUri,
  MerchantOAuthServer,
  MerchantOAuthStore,
} from "../auth/merchant-oauth.js";
import { MerchantAdminSessions } from "../auth/merchant-sessions.js";
import { MerchantOAuthVerifier } from "../auth/merchant-authorization.js";
import type { ScopedMcpTools } from "../mcp/merchant-server.js";
import { CatalogConnectorIdentityClient } from "../discovery/catalog-source/connector-identity.js";
import { isLoopbackHost } from "../a2a/client/url-policy.js";
import { EXIT } from "../exit-codes.js";
import { buildCatalogTools } from "./catalog-tools.js";
import { MerchantPublicationClient } from "./catalog-publications.js";
import { GatewayCredentialVault } from "./credential-vault.js";
import { buildInstanceTools, InstanceToolListCache } from "./instance-tools.js";
import { InstanceRegistrationStore } from "./instance-registration.js";
import { combineScopedTools } from "./tool-bundle.js";
import {
  loadTenantBackendConfigs,
  TenantBackendError,
  TenantBackendRegistry,
  type TenantBackendConfig,
} from "./tenant-registry.js";
import {
  DEFAULT_GATEWAY_ENTRY_PATH,
  DEFAULT_GATEWAY_ENTRY_PORT,
  startGatewayEntryServer,
  type GatewayEntryServerHandle,
} from "./entry-server.js";

const DEFAULT_CATALOG_URL = "https://catalog.kiwi.harrylabsj.com";
/** 默认商家连接器 source（平台唯一性待核验；核验后按此处替换即可）。 */
export const DEFAULT_MERCHANT_CONNECTOR_SOURCE = "kiwi-merchant";
const DEFAULT_CONNECTOR_TOKEN_ENV = "KIWI_CATALOG_CONNECTOR_TOKEN";

export interface GatewayServeOptions {
  publicUrl?: string;
  catalogUrl: string;
  source: string;
  host: string;
  port: number;
  mcpPath: string;
  dataDir: string;
  connectorTokenEnv: string;
  credentialKeyEnv: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  trustedProxy: boolean;
  allowLoopbackCallback: boolean;
  callbackUri?: string;
  checkOnly: boolean;
  portalBaseUrl?: string;
  /** 运维提供的租户（实例）配置 JSON 文件；缺省表示尚无商家配对实例。 */
  tenantConfigPath?: string;
}

export function defaultGatewayDataDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".kiwi", "gateway");
}

/** 解析 `kiwi merchant gateway serve` 的原始 flag（含 `--check`）。 */
export function parseGatewayServeArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): GatewayServeOptions {
  const opts: GatewayServeOptions = {
    catalogUrl: env.KIWI_CATALOG_URL ?? DEFAULT_CATALOG_URL,
    source: DEFAULT_MERCHANT_CONNECTOR_SOURCE,
    host: "127.0.0.1",
    port: DEFAULT_GATEWAY_ENTRY_PORT,
    mcpPath: DEFAULT_GATEWAY_ENTRY_PATH,
    dataDir: defaultGatewayDataDir(),
    connectorTokenEnv: DEFAULT_CONNECTOR_TOKEN_ENV,
    credentialKeyEnv: "KIWI_GATEWAY_CREDENTIAL_KEY",
    trustedProxy: false,
    allowLoopbackCallback: true,
    checkOnly: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--check") {
      opts.checkOnly = true;
      continue;
    }
    if (flag === "--trusted-proxy") {
      opts.trustedProxy = true;
      continue;
    }
    if (flag === "--no-loopback-callback") {
      opts.allowLoopbackCallback = false;
      continue;
    }
    if (value === undefined) continue;
    if (flag === "--public-url") opts.publicUrl = value;
    else if (flag === "--catalog-url") opts.catalogUrl = value;
    else if (flag === "--source") opts.source = value;
    else if (flag === "--host") opts.host = value;
    else if (flag === "--port") opts.port = Number(value);
    else if (flag === "--mcp-path") opts.mcpPath = value;
    else if (flag === "--data-dir") opts.dataDir = value;
    else if (flag === "--connector-token-env") opts.connectorTokenEnv = value;
    else if (flag === "--credential-key-env") opts.credentialKeyEnv = value;
    else if (flag === "--tls-cert") opts.tlsCertPath = value;
    else if (flag === "--tls-key") opts.tlsKeyPath = value;
    else if (flag === "--callback-uri") opts.callbackUri = value;
    else if (flag === "--portal-url") opts.portalBaseUrl = value;
    else if (flag === "--tenant-config") opts.tenantConfigPath = value;
  }
  return opts;
}

export interface GatewayServeReadiness {
  /** 公网入口（OAuth issuer / 连接回跳基准）。 */
  publicUrl: string;
  /** 生效的 OAuth 回调地址（source 派生或显式配置）。 */
  callbackUri: string;
  /** 由本进程终止 TLS。 */
  directTls: boolean;
  /** 监听非 loopback（依赖直接 TLS 或受信反向代理）。 */
  nonLoopback: boolean;
  /** 依赖加密存储的功能是否启用（缺密钥即 false）。 */
  encryptedFeaturesEnabled: boolean;
  /** 已注册（已配对）的商家实例数量；0 表示第 1 版路由未启用。 */
  registeredInstances: number;
  connectorTokenConfigured: boolean;
  warnings: string[];
}

export type GatewayServeValidation =
  { ok: true; readiness: GatewayServeReadiness } | { ok: false; error: string };

/**
 * 启动前校验（fail-closed）。纯函数，便于测试与 `--check` 复用。
 *
 * 规则：
 *   - `--public-url` 必填，且 https（loopback http 仅限本地开发）；
 *   - 监听非 loopback 必须给出 TLS 材料，或显式 `--trusted-proxy`；
 *   - TLS 证书与私钥必须成对；
 *   - connector token 必须已配置（缺少则入口无法建立商家身份，直接拒绝启动）；
 *   - 凭据加密密钥缺失**不**拒绝启动，但关闭依赖加密存储的功能并给出警告。
 */
export function validateGatewayServeOptions(
  opts: GatewayServeOptions,
  env: Record<string, string | undefined> = process.env,
): GatewayServeValidation {
  const publicUrlRaw = (opts.publicUrl ?? "").trim();
  if (publicUrlRaw === "") {
    return {
      ok: false,
      error: "缺少 --public-url（公网 HTTPS 入口，用于 OAuth issuer 与连接回跳）",
    };
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(publicUrlRaw);
  } catch {
    return { ok: false, error: `--public-url 不是合法 URL：${publicUrlRaw}` };
  }
  if (publicUrl.username !== "" || publicUrl.password !== "") {
    return { ok: false, error: "--public-url 不得内嵌凭据（userinfo）" };
  }
  if (publicUrl.search !== "" || publicUrl.hash !== "") {
    return { ok: false, error: "--public-url 不得包含查询串或片段" };
  }
  if (publicUrl.protocol !== "https:" && !isLoopbackHost(publicUrl.hostname)) {
    return {
      ok: false,
      error: `--public-url 必须是 https（除非 loopback 开发地址）：${publicUrlRaw}`,
    };
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    return { ok: false, error: `--port 非法：${opts.port}` };
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(opts.source)) {
    return { ok: false, error: `--source 非法（小写字母/数字/连字符）：${opts.source}` };
  }
  // 目录地址校验：http(s)、无 userinfo、无查询串。
  try {
    const catalogUrl = new URL(opts.catalogUrl);
    if (
      (catalogUrl.protocol !== "http:" && catalogUrl.protocol !== "https:") ||
      catalogUrl.username !== "" ||
      catalogUrl.password !== ""
    ) {
      return { ok: false, error: `--catalog-url 非法：${opts.catalogUrl}` };
    }
  } catch {
    return { ok: false, error: `--catalog-url 非法：${opts.catalogUrl}` };
  }

  const hasCert = (opts.tlsCertPath ?? "").trim() !== "";
  const hasKey = (opts.tlsKeyPath ?? "").trim() !== "";
  if (hasCert !== hasKey) {
    return { ok: false, error: "--tls-cert 与 --tls-key 必须成对提供" };
  }
  if (hasCert) {
    for (const file of [opts.tlsCertPath, opts.tlsKeyPath]) {
      if (!existsSync(String(file))) {
        return { ok: false, error: `TLS 材料不存在：${file}` };
      }
    }
  }
  const nonLoopback = !isLoopbackHost(opts.host);
  if (nonLoopback && !hasCert && !opts.trustedProxy) {
    return {
      ok: false,
      error:
        `监听非 loopback 地址（${opts.host}）时必须二选一：` +
        "提供 --tls-cert/--tls-key 由本进程终止 TLS，或显式声明 --trusted-proxy（TLS 由受信反向代理终止）",
    };
  }

  const connectorToken = (env[opts.connectorTokenEnv] ?? "").trim();
  if (connectorToken === "") {
    return {
      ok: false,
      error:
        `环境变量 ${opts.connectorTokenEnv} 未配置：入口需要目录发给的 connector token ` +
        "才能创建/兑换一次性身份授权请求（它不授予商家数据访问）",
    };
  }

  const credentialKey = (env[opts.credentialKeyEnv] ?? "").trim();
  const warnings: string[] = [];
  if (credentialKey === "") {
    warnings.push(
      `环境变量 ${opts.credentialKeyEnv} 未配置：依赖加密存储的功能（第 0 版目录工具、第 1 版实例路由）未启用。` +
        "配置该密钥后重启即可启用（商家需重新连接一次）。",
    );
  }
  let registeredInstances = 0;
  if ((opts.tenantConfigPath ?? "").trim() !== "") {
    const configPath = String(opts.tenantConfigPath);
    if (!existsSync(configPath)) {
      return { ok: false, error: `租户配置文件不存在：${configPath}` };
    }
    try {
      const configs = loadTenantBackendConfigs(readFileSync(configPath, "utf8"));
      registeredInstances = new TenantBackendRegistry(configs).size;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof TenantBackendError ? err.message : String(err),
      };
    }
  }
  if (nonLoopback && opts.trustedProxy && !hasCert) {
    warnings.push(
      `监听 ${opts.host} 且未由本进程终止 TLS：仅当受信反向代理已终止 TLS 并限制直连时可用；` +
        `公网入口必须为 ${publicUrl.origin}。`,
    );
  }
  if (publicUrl.protocol === "http:") {
    warnings.push("--public-url 为 http（loopback 开发地址）：不可用于生产。");
  }

  return {
    ok: true,
    readiness: {
      publicUrl: publicUrl.origin,
      callbackUri: expectedCallbackUri(opts.source, {
        ...(opts.callbackUri !== undefined ? { expectedCallbackUri: opts.callbackUri } : {}),
        allowLoopbackFallback: opts.allowLoopbackCallback,
      }),
      directTls: hasCert,
      nonLoopback,
      encryptedFeaturesEnabled: credentialKey !== "",
      registeredInstances,
      connectorTokenConfigured: true,
      warnings,
    },
  };
}

function resolveGatewayDataDir(dir: string): string {
  const resolved = path.resolve(dir);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  try {
    chmodSync(resolved, 0o700);
  } catch {
    // 只读/受限文件系统：目录已按 0700 创建，权限收紧失败不阻塞启动。
  }
  return resolved;
}

/** 打开（或预建）oauth.sqlite：先以 0600 建空文件再打开，消除权限窗口。 */
function openGatewayStore(dataDir: string): DatabaseSync {
  const dbPath = path.join(dataDir, "oauth.sqlite");
  if (!existsSync(dbPath)) {
    writeFileSync(dbPath, "", { mode: 0o600 });
  }
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  return db;
}

const USAGE = `usage: kiwi merchant gateway serve [options]

商家连接器（Kiwi 商家运营）远程 MCP 入口。买方连接器（kiwi-sourcing）由
本地 stdio 承载，不由本命令提供服务。

  --public-url <url>           必填。公网入口（https；loopback http 仅限开发）
  --catalog-url <url>          kiwi-catalog 地址（缺省 KIWI_CATALOG_URL）
  --source <name>              连接器 source（缺省 ${DEFAULT_MERCHANT_CONNECTOR_SOURCE}）
  --host <host>                监听地址（缺省 127.0.0.1）
  --port <n>                   监听端口（缺省 ${DEFAULT_GATEWAY_ENTRY_PORT}）
  --mcp-path <path>            MCP endpoint 路径（缺省 /mcp）
  --data-dir <dir>             状态目录（缺省 <cwd>/.kiwi/gateway）
  --connector-token-env <ENV>  connector token 的环境变量名（缺省 ${DEFAULT_CONNECTOR_TOKEN_ENV}）
  --credential-key-env <ENV>   凭据加密密钥的环境变量名（缺省 KIWI_GATEWAY_CREDENTIAL_KEY）
  --tls-cert <file>            TLS 证书（与 --tls-key 成对；由本进程终止 TLS）
  --tls-key <file>             TLS 私钥
  --trusted-proxy              TLS 由受信反向代理终止（允许监听非 loopback）
  --callback-uri <uri>         显式指定期望 OAuth 回调（缺省按 source 派生）
  --no-loopback-callback       不允许 http loopback 回退回调
  --portal-url <url>           目录门户地址（公开资料确认入口）
  --tenant-config <file>       商家实例注册表 JSON（{tenants:[{merchant_id,mcp_url,
                               token_env|credential_kind:"vault"}]}；可选，商家也可在
                               /instance 页面自助绑定实例）
  --check                      只校验配置与就绪状态，不启动监听
`;

/** 启动摘要：把三类凭据的分工与功能开关显式打印，避免部署误判。 */
function printReadiness(
  opts: GatewayServeOptions,
  readiness: GatewayServeReadiness,
  handle?: GatewayEntryServerHandle,
): void {
  const listen = handle === undefined ? `${opts.host}:${opts.port}（未启动）` : handle.url;
  const lines = [
    "kiwi merchant gateway serve",
    `  公网入口        ${readiness.publicUrl}`,
    `  本地监听        ${listen}${readiness.directTls ? "（本进程终止 TLS）" : "（TLS 应由受信反向代理终止）"}`,
    `  连接器 source   ${opts.source}`,
    `  OAuth 回调      ${readiness.callbackUri}`,
    `  目录服务        ${opts.catalogUrl}`,
    `  状态目录        ${opts.dataDir}`,
    `  实例绑定页      ${readiness.publicUrl}/instance（需商家登录态）`,
    "凭据分工（互不通用）：",
    "  用户 OAuth token    WorkBuddy ↔ 入口（授权码 + PKCE；入口只存摘要）",
    `  connector token     入口 → 目录：创建/兑换一次性身份授权请求（env ${opts.connectorTokenEnv}），不授予商家数据访问`,
    "  商家目录凭据 cmt_…  入口 → 目录：读写该商家公开资料（发布仍须商家在门户确认）",
    "  实例内部凭据        入口 → 商家自托管实例（第 1 版路由）",
    `  凭据加密密钥        仅本进程使用（env ${opts.credentialKeyEnv}），不落库、不下发`,
    "功能：",
    "  ✓ 商家连接与授权（OAuth 2.1 + PKCE）",
    readiness.encryptedFeaturesEnabled
      ? "  ✓ 第 0 版目录工具（公开资料草稿/状态/撤回 + 门户确认入口）"
      : "  ✗ 第 0 版目录工具（未配置凭据加密密钥）",
    readiness.registeredInstances > 0
      ? `  ✓ 第 1 版实例路由（静态配置 ${readiness.registeredInstances} 个；商家自助绑定在 /instance 页面完成）`
      : "  ✓ 第 1 版实例路由（静态配置 0 个；商家可在 /instance 页面自助绑定实例）",
  ];
  for (const warning of readiness.warnings) {
    lines.push(`  ⚠️ ${warning}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function runGatewayServe(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  const opts = parseGatewayServeArgs(args, env);
  const validation = validateGatewayServeOptions(opts, env);
  if (!validation.ok) {
    process.stderr.write(`${validation.error}\n\n${USAGE}`);
    return EXIT.CONFIG;
  }
  const readiness = validation.readiness;
  if (opts.checkOnly) {
    printReadiness(opts, readiness);
    return EXIT.OK;
  }

  const dataDir = resolveGatewayDataDir(opts.dataDir);
  const db = openGatewayStore(dataDir);
  const oauthStore = new MerchantOAuthStore({ db });
  const credentialSecret = env[opts.credentialKeyEnv];
  const vault =
    credentialSecret !== undefined && credentialSecret.trim() !== ""
      ? new GatewayCredentialVault({ db, secret: credentialSecret })
      : undefined;

  const oauth = new MerchantOAuthServer({
    store: oauthStore,
    issuer: readiness.publicUrl,
    resource: `${readiness.publicUrl}${opts.mcpPath}`,
    connectorSource: opts.source,
    multiMerchant: true,
    // 目录 scope（第 0 版工具）+ 实例 scope（第 1 版工具，经 mcp-proxy 逐次校验）。
    scopes: ["catalog:read", "catalog:write", "merchant:read", "merchant:write"],
    loginPath: "/connect",
    callbackPolicy: {
      ...(opts.callbackUri !== undefined ? { expectedCallbackUri: opts.callbackUri } : {}),
      allowLoopbackFallback: opts.allowLoopbackCallback,
    },
  });

  const publicationClient = new MerchantPublicationClient({ baseUrl: opts.catalogUrl });
  const portalBaseUrl = opts.portalBaseUrl ?? opts.catalogUrl;

  // 商家自助绑定的实例登记（§8.4 第一期）：需要加密保管库，缺密钥时不启用。
  const registrations = vault !== undefined ? new InstanceRegistrationStore({ db }) : undefined;

  // 实例注册表 = 运维静态配置 + 商家自助绑定（§8.4）。
  // 凭据来源为 vault 的实例需要加密密钥：缺密钥时**这些实例不启用**
  // （其余静态实例与第 0 版能力不受影响）。
  let staticConfigs: TenantBackendConfig[] = [];
  if ((opts.tenantConfigPath ?? "").trim() !== "") {
    staticConfigs = loadTenantBackendConfigs(readFileSync(String(opts.tenantConfigPath), "utf8"));
    if (vault === undefined) {
      const kept = staticConfigs.filter((c) => c.credentialKind !== "vault");
      if (kept.length < staticConfigs.length) {
        process.stderr.write(
          `⚠️ 未配置凭据加密密钥：${staticConfigs.length - kept.length} 个 vault 凭据实例未启用\n`,
        );
      }
      staticConfigs = kept;
    }
  }
  const tenantRegistry = new TenantBackendRegistry(staticConfigs, env, {
    ...(vault !== undefined ? { credentials: vault } : {}),
    ...(registrations !== undefined ? { dynamic: { lookup: (id) => registrations.get(id) } } : {}),
  });
  const instanceToolCache = new InstanceToolListCache();
  const handle = await startGatewayEntryServer({
    publicBaseUrl: readiness.publicUrl,
    oauth,
    sessions: new MerchantAdminSessions({ db }),
    identity: new CatalogConnectorIdentityClient({
      baseUrl: opts.catalogUrl,
      connectorToken: String(env[opts.connectorTokenEnv] ?? "").trim(),
    }),
    auth: new MerchantOAuthVerifier({ store: oauthStore, multiMerchant: true }),
    ...(vault !== undefined ? { credentials: vault } : {}),
    ...(vault !== undefined && registrations !== undefined
      ? { instanceBinding: { registrations, credentials: vault } }
      : {}),
    // 每请求按已验证主体组合工具束：第 0 版目录工具 + 该商家的第 1 版实例工具。
    toolsFor: (authorization) => {
      const merchantId = authorization?.merchant_id ?? "";
      if (merchantId === "") return undefined;
      const bundles: Array<ScopedMcpTools | undefined> = [];
      if (vault !== undefined) {
        bundles.push(
          buildCatalogTools(merchantId, {
            client: publicationClient,
            credentials: vault,
            portalBaseUrl,
          }),
        );
      }
      if (tenantRegistry !== undefined && authorization !== undefined) {
        bundles.push(
          buildInstanceTools({
            registry: tenantRegistry,
            authorization,
            cache: instanceToolCache,
          }),
        );
      }
      return combineScopedTools(bundles);
    },
    ...(opts.tlsCertPath !== undefined && opts.tlsKeyPath !== undefined
      ? { tls: { certPath: opts.tlsCertPath, keyPath: opts.tlsKeyPath } }
      : {}),
    host: opts.host,
    port: opts.port,
    mcpPath: opts.mcpPath,
    secureCookies: readiness.publicUrl.startsWith("https://"),
    clientLabel: "Kiwi 商家运营",
    serverInfo: { name: "kiwi-merchant-entry", version: "0.1.0" },
  });

  printReadiness(opts, readiness, handle);

  return await new Promise<number>((resolve) => {
    const shutdown = (): void => {
      void handle.close().then(() => {
        db.close();
        resolve(EXIT.OK);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
