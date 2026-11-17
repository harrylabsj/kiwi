/**
 * 独立部署商家工作台（`kiwi merchant workbench serve`）。
 *
 * 复用云端 `/merchant/` 页面与 `/merchant/api/*` 管理 API，但装配本地运行时：
 *   - 本地 owner 登录复用 `/admin/login`（admin-credentials.json + 管理会话）；
 *   - 商品列表通过 shopping-cli 开放层只读投影；
 *   - 报价规则经运行中策略运行时提交（与 A2A/MCP 同一份 policy）；
 *   - 目录连接、商品导入、经营计划等云端能力不装配，对应页签明确 503。
 *
 * 页面与 API 仍由同一进程提供；`/merchant/` 与目录侧派生的工作台 URL 约定
 * 一致，独立部署暴露公网时可被 `/portal/account` 直接链接。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AgentProfile } from "../config/profile.js";
import { resolveSecret } from "../config/profile.js";
import { ShoppingCliCommerceDataSource } from "../commerce/shopping-cli-source.js";
import { createMerchantManagementApiHandler } from "../http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../http/merchant-management/operation-store.js";
import { renderMerchantManagementPage } from "../http/merchant-management/page.js";
import { MutableServiceState } from "../http/merchant-management/service-state.js";
import { openMerchantOperationsFacade } from "../merchant-core/ops/facade.js";
import { MerchantOperationsSurface } from "../merchant-core/ops/surface.js";
import { createTrustedWorkbenchPageHandler } from "../http/merchant-management/trusted-page.js";
import { WorkbenchConfirmationStore } from "../http/merchant-management/webauthn-confirmation.js";
import { ManagementError, type MerchantProductPage, type PageQuery } from "../merchant/application/service.js";
import { createMerchantHttpHandler } from "../mcp/merchant-server.js";
import { assembleMerchantRuntime } from "../mcp/merchant-runtime-assembly.js";
import { PRODUCT_VERSION } from "../product-cli.js";
import { DEFAULT_MERCHANT_MCP_PATH } from "../mcp/merchant-server.js";

export const DEFAULT_MERCHANT_WORKBENCH_PORT = 9102;

export interface StandaloneWorkbenchOptions {
  profile: AgentProfile;
  dataDir: string;
  host: string;
  port: number;
  /** 对外 origin（https），用于同源写请求 Origin 校验；缺省允许 loopback。 */
  publicOrigin?: string;
  log?: (line: string) => void;
}

export interface StandaloneWorkbenchHandle {
  url: string;
  close: () => Promise<void>;
}

function allowedOrigins(host: string, port: number, publicOrigin?: string): string[] {
  const origins = new Set<string>();
  if (publicOrigin !== undefined && publicOrigin !== "") {
    origins.add(publicOrigin.replace(/\/+$/, ""));
  }
  if (host === "0.0.0.0" || host === "::" || host === "127.0.0.1" || host === "::1" || host === "localhost") {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
  }
  return [...origins];
}

function buildProductReader(
  profile: AgentProfile,
): { read: (query: PageQuery) => Promise<MerchantProductPage>; source: ShoppingCliCommerceDataSource } | undefined {
  let authToken: string | undefined;
  if (profile.commerce.token_env !== "") {
    try {
      authToken = resolveSecret(profile.commerce.token_env, "commerce token");
    } catch {
      authToken = undefined;
    }
  }
  const source = new ShoppingCliCommerceDataSource({
    baseUrl: profile.commerce.base_url,
    ...(authToken !== undefined ? { authToken } : {}),
  });
  return {
    source,
    read: async (query) => {
      let facts;
      try {
        facts = await source.getProducts({ limit: Math.min(Math.max(query.limit ?? 50, 1), 100) });
      } catch (err) {
        throw new ManagementError(
          "unavailable",
          `product source unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const now = Date.now();
      return {
        items: facts.map((fact) => ({
          sku: fact.sku,
          title: fact.title ?? fact.sku,
          currency: fact.currency ?? "CNY",
          price: fact.price_minor !== undefined ? fact.price_minor / 100 : 0,
          price_unit: fact.unit ?? profile.commerce.default_unit ?? null,
          min_order_qty: null,
          valid_until: fact.valid_until ?? null,
          updated_at: null,
          status:
            fact.valid_until !== undefined && Date.parse(fact.valid_until) <= now
              ? "expired"
              : "active",
        })),
        next_cursor: null,
      };
    },
  };
}

function routeRequest(input: {
  page: string;
  api: (req: IncomingMessage, res: ServerResponse) => void;
  admin: (req: IncomingMessage, res: ServerResponse) => void;
  trusted?: (req: IncomingMessage, res: ServerResponse) => void;
  version: string;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://workbench.internal").pathname;
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("bad request");
      return;
    }
    if (pathname === "/merchant" || pathname === "/merchant/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(input.page);
      return;
    }
    if (pathname.startsWith("/merchant/api/")) {
      input.api(req, res);
      return;
    }
    if (pathname.startsWith("/merchant/trusted/") && input.trusted !== undefined) {
      input.trusted(req, res);
      return;
    }
    if (pathname === "/livez") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, version: input.version }));
      return;
    }
    if (
      pathname.startsWith("/admin/") ||
      pathname.startsWith("/oauth/") ||
      pathname.startsWith("/pairing/") ||
      pathname === "/.well-known/openid-configuration" ||
      pathname.startsWith("/.well-known/oauth-")
    ) {
      input.admin(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  };
}

export async function startStandaloneMerchantWorkbench(
  options: StandaloneWorkbenchOptions,
): Promise<StandaloneWorkbenchHandle> {
  const { profile, dataDir, host, port } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(line));
  if (profile.role !== "merchant") {
    throw new Error("standalone workbench requires a merchant profile");
  }
  const mcpPath = profile.merchant_mcp?.path ?? DEFAULT_MERCHANT_MCP_PATH;
  const assembly = await assembleMerchantRuntime({
    profile,
    dataDir,
    host,
    port,
    mcpPath,
    authMode: profile.merchant_mcp?.auth_mode ?? "oauth",
    ...(profile.merchant_mcp?.public_url !== undefined
      ? { issuer: profile.merchant_mcp.public_url }
      : {}),
    ...(profile.merchant_mcp?.token_env !== undefined
      ? { tokenEnv: profile.merchant_mcp.token_env }
      : {}),
    adminDefaultNext: "/merchant/",
    adminPendingBackLink: { href: "/merchant/", label: "返回商家工作台" },
  });
  const admin = assembly.serverOptions.admin;
  if (admin === undefined) {
    await assembly.close().catch(() => undefined);
    throw new Error("merchant admin surface is not configured; run `kiwi merchant mcp admin-passwd` first");
  }

  const db = new DatabaseSync(`${dataDir}/state.sqlite`);
  const serviceState = MutableServiceState.fromDeclared(process.env.KIWI_WORKBENCH_SERVICE_STATE);
  serviceState.attachPersistence(db, profile.owner_id);
  const now = () => new Date().toISOString();
  const drafts = new MerchantImportDraftStore({ db, now });
  // TOP1-3 管理路由：学习/记忆/经营任务统一经运营门面；只有 workbench
  // 持有治理所有权时，公共 `/merchant/api/v1/learning/*`、`/automation/*`
  // 才挂载，避免与 a2a/cloud 写者无栅栏并发。
  const merchantOperations = assembly.governanceActive
    ? new MerchantOperationsSurface({
        facade: openMerchantOperationsFacade({
          db,
          merchantId: profile.owner_id,
          now,
        }),
        now,
      })
    : undefined;
  const operations = new MerchantManagementOperationStore({ db });
  const workbenchConfirmations = new WorkbenchConfirmationStore({ db });
  const productReader = buildProductReader(profile);
  const policyApply = assembly.service.policyApplier;
  const readiness = async () => {
    const checks: Record<string, { ok: boolean; code?: string }> = {
      policy: { ok: assembly.policy().digest !== "" },
    };
    if (productReader !== undefined) {
      try {
        const health = await productReader.source.health();
        checks.product_source = { ok: health.ok };
      } catch {
        checks.product_source = { ok: false, code: "PRODUCTS_UNREACHABLE" };
      }
    }
    return { ready: Object.values(checks).every((check) => check.ok), checks };
  };
  const api = createMerchantManagementApiHandler({
    merchantId: profile.owner_id,
    merchantName: profile.name ?? profile.owner_id,
    generation: () => 1,
    runtimeVersion: PRODUCT_VERSION,
    sessions: admin.sessions,
    allowedOrigins: allowedOrigins(host, port, options.publicOrigin ?? profile.merchant_mcp?.public_url),
    listPending: () => admin.surface.listPending(),
    mintCandidateConfirmation: (input) => admin.store.createConfirmation(input),
    executeDecision: async (input) => {
      if (input.approve) {
        await admin.surface.executeApproved(input.candidateId, input.actorId, input.confirmationRef);
      } else {
        await admin.surface.rejectCandidate(input.candidateId, input.actorId, input.confirmationRef);
      }
    },
    policy: () => assembly.policy(),
    policyCurrent: () => assembly.currentPolicy(),
    ...(productReader !== undefined ? { products: productReader.read } : {}),
    ...(policyApply !== undefined ? { policyApply } : {}),
    drafts,
    operations,
    serviceState,
    readiness,
    workbenchConfirmations,
    ...(merchantOperations !== undefined ? { merchantOperations } : {}),
    ...(assembly.assertGovernanceOwner !== undefined
      ? { assertGovernanceOwner: assembly.assertGovernanceOwner }
      : {}),
  });
  const adminHandle = createMerchantHttpHandler(assembly.serverOptions);
  const trustedPage = createTrustedWorkbenchPageHandler();
  const page = renderMerchantManagementPage({
    productAuthority: productReader !== undefined ? "file" : "exact",
    catalogConnection: false,
    workbuddyAccess: false,
  });
  const server = createServer(
    routeRequest({
      page,
      api,
      admin: adminHandle.handler,
      trusted: trustedPage,
      version: PRODUCT_VERSION,
    }),
  );
  const listening = await new Promise<{ url: string; close: (cb: () => void) => void }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        url: `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${actualPort}/merchant/`,
        close: (cb) => server.close(cb),
      });
    });
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => listening.close(resolve));
    await adminHandle.close().catch(() => undefined);
    await assembly.close().catch(() => undefined);
    try {
      db.close();
    } catch {
      // ignore close races
    }
  };
  log(`[merchant workbench] ${profile.agent_id} listening at ${listening.url}（auth: ${assembly.authLabel}）\n`);
  return { url: listening.url, close };
}

/** 测试接缝：只构造请求路由，不启动监听/装配。 */
export function createWorkbenchRequestRouter(input: {
  page: string;
  api: (req: IncomingMessage, res: ServerResponse) => void;
  admin: (req: IncomingMessage, res: ServerResponse) => void;
  trusted?: (req: IncomingMessage, res: ServerResponse) => void;
  version: string;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return routeRequest(input);
}

