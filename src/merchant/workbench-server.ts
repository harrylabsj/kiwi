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

import { createCustomerIdentityReceiver } from "../a2a/server/customer-identity-gateway.js";
import { startMemoryProposalServer } from "../merchant-core/customer-memory/private-transport.js";
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
import { createTrustedWorkbenchPageHandler } from "../http/merchant-management/trusted-page.js";
import { WorkbenchConfirmationStore } from "../http/merchant-management/webauthn-confirmation.js";
import { ManagementError, type MerchantProductPage, type PageQuery } from "../merchant/application/service.js";
import { createMerchantHttpHandler } from "../mcp/merchant-server.js";
import { assembleMerchantRuntime } from "../mcp/merchant-runtime-assembly.js";
import { createOperationAdviceRunner } from "../merchant-core/operations-jobs/advice-runner.js";
import { OperationsScheduler } from "../merchant-core/operations-jobs/scheduler.js";
import { OperationsProjection } from "../merchant-core/operations-jobs/projection.js";
import { CustomerDataMaintenance } from "../merchant-core/customer-memory/maintenance.js";
import { DeliveryConsentRepository } from "../merchant-core/customer-delivery/consent-repository.js";
import { DeliveryDispatcherLoop } from "../merchant-core/customer-delivery/dispatcher-loop.js";
import { assertDeliveryStillAuthorized } from "../merchant-core/customer-delivery/gate.js";
import { createSmtpChannelAdapter } from "../merchant-core/customer-delivery/smtp-adapter.js";
import { buildModel, realStreamFn } from "../runtime/model.js";
import { PRODUCT_VERSION } from "../product-cli.js";
import { DEFAULT_MERCHANT_MCP_PATH } from "../mcp/merchant-server.js";

export const DEFAULT_MERCHANT_WORKBENCH_PORT = 9102;

export interface StandaloneWorkbenchOptions {
  recoveryVerifier?: import("../merchant-core/learning/service.js").LearningServiceOptions["recoveryVerifier"];
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
  // P2-11：绑定具体网卡 IP（如 192.168.x）时浏览器同源 Origin 就是
  // host:port；未配置 --public-url 也应允许，而不是静默 403 全部写请求。
  if (host !== "" && host !== "0.0.0.0" && host !== "::") {
    origins.add(`http://${host}:${port}`);
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
    ...(options.recoveryVerifier !== undefined ? { recoveryVerifier: options.recoveryVerifier } : {}),
    adminPendingBackLink: { href: "/merchant/", label: "返回商家工作台" },
  });
  const admin = assembly.serverOptions.admin;
  if (admin === undefined) {
    await assembly.close().catch(() => undefined);
    throw new Error("merchant admin surface is not configured; run `kiwi merchant mcp admin-passwd` first");
  }

  const db = new DatabaseSync(`${dataDir}/state.sqlite`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  const deliveryConsent = new DeliveryConsentRepository({ db, now: () => new Date().toISOString() });
  const serviceState = MutableServiceState.fromDeclared(process.env.KIWI_WORKBENCH_SERVICE_STATE);
  serviceState.attachPersistence(db, profile.owner_id);
  const now = () => new Date().toISOString();
  const drafts = new MerchantImportDraftStore({ db, now });
  // 治理业务与所有权事务须使用装配持有的同一个 SQLite 连接。
  const { merchantOperations, governance, operationsJobs } = assembly;
  // 经营任务调度：仅所有权持有进程、显式开关且真实模型时启动。缺投影数据
  // 时调度器只产生 data_incomplete 待办（不伪造 no_change）。
  let operationsScheduler: OperationsScheduler | undefined;
  if (
    governance !== undefined &&
    operationsJobs !== undefined &&
    process.env.KIWI_OPERATIONS_SCHEDULER === "1" &&
    profile.model?.provider !== undefined &&
    profile.model.provider !== "fake"
  ) {
    const runner = createOperationAdviceRunner({
      streamFn: realStreamFn(),
      model: buildModel(profile),
      ...(profile.model.api_key_env !== undefined
        ? { getApiKey: () => process.env[profile.model.api_key_env as string] }
        : {}),
      now,
    });
    const projection = new OperationsProjection({ db, now });
    operationsScheduler = new OperationsScheduler({
      service: operationsJobs,
      merchant_id: profile.owner_id,
      prefilter: (rule) => projection.prefilter(rule),
      assertOwner: () => governance.write(() => undefined),
      write: governance.write,
      runner,
      now,
      log: (line: string) => process.stderr.write(line),
    });
    operationsScheduler.start();
  }
  // 保留期清算：与经营调度并列，只由所有权持有进程每小时执行（P1-7）。
  let customerDataMaintenance: CustomerDataMaintenance | undefined;
  if (
    governance !== undefined &&
    (governance.flags as unknown as { memory_enabled?: boolean }).memory_enabled === true
  ) {
    customerDataMaintenance = new CustomerDataMaintenance({
      db,
      now,
      write: governance.write,
      log: (line: string) => process.stderr.write(line),
    });
    customerDataMaintenance.start();
  }
  // P1 邮件投递循环：显式开关 + SMTP + 按绑定解析的收件人映射齐全才启动。
  // 收件人只来自 `KIWI_DELIVERY_RECIPIENTS`（address_ref → 地址），不再使用
  // 固定 env 收件人，避免所有绑定共用一个地址（P1-5）。
  let deliveryDispatcher: DeliveryDispatcherLoop | undefined;
  const deliveryRepository = assembly.customerDeliveries;
  const deliveryFlagEnabled =
    governance !== undefined &&
    (governance.flags as unknown as { customer_delivery_enabled: boolean })
      .customer_delivery_enabled === true;
  if (deliveryFlagEnabled && process.env.KIWI_DELIVERY_DISPATCHER === "1") {
    const smtp = {
      host: String(process.env.KIWI_DELIVERY_EMAIL_SMTP_HOST ?? "").trim(),
      port: Number(process.env.KIWI_DELIVERY_EMAIL_SMTP_PORT ?? "587"),
      user: String(process.env.KIWI_DELIVERY_EMAIL_SMTP_USER ?? "").trim(),
      password: String(process.env.KIWI_DELIVERY_EMAIL_SMTP_PASSWORD ?? ""),
      from: String(process.env.KIWI_DELIVERY_EMAIL_FROM ?? "").trim(),
    };
    let recipients: Record<string, string> = {};
    try {
      const parsed = JSON.parse(String(process.env.KIWI_DELIVERY_RECIPIENTS ?? "{}")) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        recipients = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, string] =>
              entry[0].trim() !== "" && typeof entry[1] === "string" && entry[1].trim() !== "",
          ),
        );
      }
    } catch {
      process.stderr.write(
        "[delivery dispatcher] KIWI_DELIVERY_RECIPIENTS 不是合法 JSON，投递保持关闭\n",
      );
    }
    if (
      smtp.host !== "" &&
      smtp.user !== "" &&
      smtp.password !== "" &&
      smtp.from !== "" &&
      Object.keys(recipients).length > 0
    ) {
      const emailAdapter = createSmtpChannelAdapter({
        host: smtp.host,
        port: smtp.port,
        user: smtp.user,
        password: smtp.password,
        from: smtp.from,
      });
      deliveryDispatcher = new DeliveryDispatcherLoop({
        store: deliveryRepository,
        merchant_id: profile.owner_id,
        adapterFor: (delivery) => (delivery.channel === "email" ? emailAdapter : undefined),
        // 发送时复核绑定/订阅/退订/频控（P1-4）。
        authorize: (delivery) => {
          const binding = deliveryConsent.getBinding(profile.owner_id, delivery.binding_id);
          const subscription = deliveryConsent.getSubscription(
            profile.owner_id,
            delivery.subscription_id,
          );
          assertDeliveryStillAuthorized({
            merchant_id: profile.owner_id,
            binding,
            subscription,
            purpose: delivery.purpose,
            source_grants: delivery.source_grants,
            now: now(),
            sent_today: deliveryRepository.countSentToday(
              profile.owner_id,
              delivery.subscription_id,
              now(),
            ),
            expected_binding_epoch: delivery.binding_epoch,
            expected_subscription_epoch: delivery.subscription_epoch,
          });
          // 来源授权以账本为准复核：prepare 后撤销/过期不得继续发送。
          const grantLookup = db.prepare(
            "SELECT status, expires_at FROM data_grants WHERE merchant_id = ? AND grant_id = ?",
          );
          for (const grant of delivery.source_grants) {
            const row = grantLookup.get(profile.owner_id, grant.grant_id) as
              | { status: string; expires_at: string }
              | undefined;
            if (
              row === undefined ||
              row.status !== "ACTIVE" ||
              Date.parse(row.expires_at) <= Date.parse(now())
            ) {
              throw new Error("delivery_source_grant_revoked");
            }
          }
        },
        resolveRecipient: (delivery) => {
          const binding = deliveryConsent.getBinding(profile.owner_id, delivery.binding_id);
          return binding === undefined ? undefined : recipients[binding.address_ref];
        },
        now,
        assertOwner: () => governance.write(() => undefined),
        write: governance.write,
        log: (line) => process.stderr.write(line),
      });
      deliveryDispatcher.start();
    }
  }
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
  const writeOrigins = allowedOrigins(
    host,
    port,
    options.publicOrigin ?? profile.merchant_mcp?.public_url,
  );
  const api = createMerchantManagementApiHandler({
    receiveCustomerIdentity: createCustomerIdentityReceiver({
      db, now, merchantId: profile.owner_id, assertOwner: assembly.assertGovernanceOwner,
    }),
    merchantId: profile.owner_id,
    merchantName: profile.name ?? profile.owner_id,
    generation: () => 1,
    runtimeVersion: PRODUCT_VERSION,
    sessions: admin.sessions,
    allowedOrigins: writeOrigins,
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
    deliveryConsent,
    customerDeliveries: deliveryRepository,
    ...(governance !== undefined ? { governance } : {}),
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
      if (["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(host)) {
        writeOrigins.push(`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`);
      }
      resolve({
        url: `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${actualPort}/merchant/`,
        close: (cb) => server.close(cb),
      });
    });
  });
  let memoryServer: Awaited<ReturnType<typeof startMemoryProposalServer>> | undefined;
  try {
    const socketPath = process.env.KIWI_MEMORY_SOCKET_PATH;
    if (socketPath) {
      if (!assembly.proposeReceptionMemory) throw new Error("memory writer unavailable");
      memoryServer = await startMemoryProposalServer(socketPath, assembly.proposeReceptionMemory);
    }
  } catch (error) {
    await new Promise<void>((resolve) => listening.close(resolve));
    await adminHandle.close().catch(() => undefined);
    await assembly.close().catch(() => undefined);
    db.close();
    throw error;
  }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    operationsScheduler?.stop();
    customerDataMaintenance?.stop();
    deliveryDispatcher?.stop();
    if (memoryServer) await new Promise<void>((resolve) => memoryServer!.close(() => resolve()));
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

