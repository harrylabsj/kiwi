/**
 * 商家连接器入口的受信任后端注册表（第 1 版实例路由）。
 *
 * 入口只知道自己的公网 URL；它从**已验证 OAuth token 的 merchant_id** 选择
 * 服务端注册的商家实例，绝不使用模型工具参数或客户端可填写的 URL 路由。
 *
 * URL 策略（fail-closed，对齐商家连接器发布计划 §3.3）：
 *   - 非 loopback 必须是 https（明文 http 仅限 loopback 开发实例）；
 *   - 复用 A2A 出站守卫 `assertSafeTargetUrl`：拒绝 userinfo、保留主机名、
 *     字面保留 IP；路径必须恰为 `/mcp`，不得带查询串或片段；
 *   - loopback 实例必须显式指定端口（避免误连本机其它服务）。
 *
 * **仍未覆盖**（不得宣称已支持异地自托管）：请求时的 DNS/IP 钉住与 mTLS
 * 尚未实现——`assertResolvableTargetUrl` 只做解析后私网复查，不能替代钉住；
 * 服务认领（配对码）与凭证轮换属后续增量。
 */

import type { MerchantAuthorization } from "../auth/merchant-authorization.js";
import { assertSafeTargetUrl, isLoopbackHost } from "../a2a/client/url-policy.js";
import type { MerchantCredentialStore } from "./credential-vault.js";

/** 实例内部凭据的保管库键前缀（与目录凭据 cmt_ 分开放）。 */
export const INSTANCE_CREDENTIAL_KIND = "instance";

export interface TenantBackendConfig {
  merchantId: string;
  /** 商家自有实例的 MCP 地址：https，或 loopback http；路径恰为 /mcp。 */
  mcpUrl: string;
  /** 内部凭据来源：进程环境变量名（运维侧注入）。 */
  tokenEnv?: string;
  /** 内部凭据来源：入口凭据保管库（加密存储；键 `<merchant_id>`，kind=instance）。 */
  credentialKind?: "env" | "vault";
}

export interface ResolvedTenantBackend {
  merchantId: string;
  mcpUrl: string;
  bearerToken: string;
}

export class TenantBackendError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_config" | "service_not_connected" | "backend_credentials_missing",
  ) {
    super(message);
    this.name = "TenantBackendError";
  }
}

/** 实例 MCP 地址规范化 + 出站策略校验（绑定页与注册表共用同一口径）。 */
export function canonicalInstanceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TenantBackendError("商家 MCP 后端 URL 非法", "invalid_config");
  }
  // 明文 http 仅限 loopback；非 loopback 必须 https。保留主机名/字面保留 IP 拒绝。
  try {
    assertSafeTargetUrl(value, { allowLoopback: true });
  } catch (err) {
    throw new TenantBackendError(
      `商家 MCP 后端地址被出站策略拒绝：${err instanceof Error ? err.message : String(err)}`,
      "invalid_config",
    );
  }
  if (url.pathname !== "/mcp" || url.search !== "" || url.hash !== "") {
    throw new TenantBackendError(
      "商家 MCP 后端路径必须恰为 /mcp，且不含查询串或片段",
      "invalid_config",
    );
  }
  if (isLoopbackHost(url.hostname)) {
    if (url.port === "" || Number(url.port) <= 0 || Number(url.port) > 65535) {
      throw new TenantBackendError("loopback 商家后端必须显式指定有效端口", "invalid_config");
    }
  } else if (url.port !== "" && (Number(url.port) <= 0 || Number(url.port) > 65535)) {
    throw new TenantBackendError("商家 MCP 后端端口非法", "invalid_config");
  }
  return url.toString();
}

export interface TenantBackendRegistryOptions {
  /** 凭据保管库（`credentialKind: "vault"` 的实例从这里取内部凭据）。 */
  credentials?: MerchantCredentialStore;
  /**
   * 动态注册（商家自助绑定，§8.4 第一期）：静态配置未命中时按 merchant_id
   * 查询商家自行绑定的实例地址；凭据同样从保管库取（键 `instance:<id>`）。
   */
  dynamic?: { lookup(merchantId: string): { mcpUrl: string } | undefined };
}

/**
 * 解析运维提供的租户配置（JSON 文本）→ 注册表配置。
 *
 * 形状：
 * ```json
 * { "tenants": [
 *   { "merchant_id": "mkt_acme_1", "mcp_url": "https://merchant.acme.example/mcp",
 *     "token_env": "ACME_MCP_TOKEN" },
 *   { "merchant_id": "mkt_dev_1", "mcp_url": "http://127.0.0.1:9100/mcp",
 *     "credential_kind": "vault" }
 * ] }
 * ```
 * 字段缺失/类型不符一律抛 TenantBackendError（invalid_config），不做默认填充。
 */
export function loadTenantBackendConfigs(raw: string): TenantBackendConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new TenantBackendError(
      `租户配置不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      "invalid_config",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TenantBackendError("租户配置必须是对象", "invalid_config");
  }
  const tenants = (parsed as { tenants?: unknown }).tenants;
  if (!Array.isArray(tenants)) {
    throw new TenantBackendError('租户配置缺 "tenants" 数组', "invalid_config");
  }
  const configs: TenantBackendConfig[] = [];
  for (const element of tenants) {
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      throw new TenantBackendError("tenants[] 必须是对象", "invalid_config");
    }
    const record = element as Record<string, unknown>;
    const merchantId = typeof record.merchant_id === "string" ? record.merchant_id.trim() : "";
    const mcpUrl = typeof record.mcp_url === "string" ? record.mcp_url.trim() : "";
    if (merchantId === "" || mcpUrl === "") {
      throw new TenantBackendError("tenants[] 必须含 merchant_id 与 mcp_url", "invalid_config");
    }
    const tokenEnv = typeof record.token_env === "string" ? record.token_env.trim() : undefined;
    const kindRaw = record.credential_kind;
    const credentialKind =
      kindRaw === undefined ? undefined : kindRaw === "vault" ? ("vault" as const) : undefined;
    if (kindRaw !== undefined && credentialKind === undefined) {
      throw new TenantBackendError(
        `tenants[] credential_kind 只支持 "vault"（实际 ${String(kindRaw)}）`,
        "invalid_config",
      );
    }
    configs.push({
      merchantId,
      mcpUrl,
      ...(tokenEnv !== undefined ? { tokenEnv } : {}),
      ...(credentialKind !== undefined ? { credentialKind } : {}),
    });
  }
  return configs;
}

/** 只由运维配置构造；尚未配对的商家不进入注册表（第 0 版能力不受影响）。 */
export class TenantBackendRegistry {
  private readonly backends = new Map<string, TenantBackendConfig>();
  private readonly env: Record<string, string | undefined>;
  private readonly credentials: MerchantCredentialStore | undefined;
  private readonly dynamic:
    { lookup(merchantId: string): { mcpUrl: string } | undefined } | undefined;

  constructor(
    configs: TenantBackendConfig[],
    env: Record<string, string | undefined> = process.env,
    options: TenantBackendRegistryOptions = {},
  ) {
    this.env = env;
    this.credentials = options.credentials;
    this.dynamic = options.dynamic;
    for (const config of configs) {
      const merchantId = config.merchantId.trim();
      if (!merchantId || !/^[a-zA-Z0-9:_-]+$/.test(merchantId)) {
        throw new TenantBackendError("商家后端配置缺合法 merchantId", "invalid_config");
      }
      if (this.backends.has(merchantId)) {
        throw new TenantBackendError(`重复商家后端配置：${merchantId}`, "invalid_config");
      }
      const kind = config.credentialKind ?? "env";
      if (kind === "env") {
        if (config.tokenEnv === undefined || !/^[A-Z][A-Z0-9_]*$/.test(config.tokenEnv)) {
          throw new TenantBackendError("商家后端 tokenEnv 必须是环境变量名", "invalid_config");
        }
      } else if (config.tokenEnv !== undefined) {
        throw new TenantBackendError(
          `商家后端 ${merchantId} 的凭据来源只能二选一（tokenEnv 或 credentialKind）`,
          "invalid_config",
        );
      }
      this.backends.set(merchantId, {
        merchantId,
        mcpUrl: canonicalInstanceUrl(config.mcpUrl),
        ...(config.tokenEnv !== undefined ? { tokenEnv: config.tokenEnv } : {}),
        credentialKind: kind,
      });
    }
  }

  /** 该商家是否已注册实例（静态配置或商家自助绑定）。 */
  has(merchantId: string): boolean {
    if (this.backends.has(merchantId)) return true;
    return this.dynamic?.lookup(merchantId) !== undefined;
  }

  /** 已注册实例数量（启动摘要用）。 */
  get size(): number {
    return this.backends.size;
  }

  /** OAuth 校验之后调用；不接受 tool arguments 中的 merchant_id 作为路由依据。 */
  resolve(authorization: MerchantAuthorization): ResolvedTenantBackend {
    if (!authorization.principal_id || !authorization.merchant_id) {
      throw new TenantBackendError("未认证的商家主体", "service_not_connected");
    }
    const backend = this.backends.get(authorization.merchant_id);
    if (backend === undefined) {
      // 商家自助绑定（§8.4）：地址来自注册表、凭据来自加密保管库；地址在这里
      // 再校验一次（防配置被改动后绕过出站策略）。
      const registered = this.dynamic?.lookup(authorization.merchant_id);
      if (registered === undefined) {
        throw new TenantBackendError(
          "当前商家尚未连接 Kiwi Merchant 实例",
          "service_not_connected",
        );
      }
      const bearerToken =
        this.credentials?.get(`${INSTANCE_CREDENTIAL_KIND}:${authorization.merchant_id}`)?.token ??
        "";
      if (!bearerToken) {
        throw new TenantBackendError("商家后端内部凭据未配置", "backend_credentials_missing");
      }
      return {
        merchantId: authorization.merchant_id,
        mcpUrl: canonicalInstanceUrl(registered.mcpUrl),
        bearerToken,
      };
    }
    const bearerToken =
      backend.credentialKind === "vault"
        ? (this.credentials?.get(`${INSTANCE_CREDENTIAL_KIND}:${backend.merchantId}`)?.token ?? "")
        : (this.env[String(backend.tokenEnv)] ?? "");
    if (!bearerToken) {
      throw new TenantBackendError("商家后端内部凭据未配置", "backend_credentials_missing");
    }
    return { merchantId: backend.merchantId, mcpUrl: backend.mcpUrl, bearerToken };
  }
}
