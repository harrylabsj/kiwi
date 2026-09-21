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
 * 云端 Runtime 启动装配（设计 v0.1.2 §8.1）。
 *
 * 启动顺序（缺任一项即拒绝启动，不静默降级）：
 *   校验平台契约与配置 → 校验商家绑定与状态目录 → 装配商家面（审批/策略/商品/
 *   工具面）→ 构造 A2A 核心（Ledger/幂等/merchant handler）→ 挂载单端口路由 →
 *   **严格**按平台端口监听（占用即失败）→ 自检并输出脱敏启动行。
 *
 * 与自托管形态的差异（全部是云端硬约束）：
 *   - 不启动交互式 CLI、不启动对话内核；
 *   - 不调用 `startA2aNode` 的 catalog 自动注册分支（目录注册由 M4 Enrollment 编排）；
 *   - 端口占用**不换端口**（T013）；
 *   - 权威状态目录必须显式给出且不在制品内（T014）；
 *   - 公网广告地址下弱认证在配置层已被拒绝（T015）。
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createA2aNodeCore, createA2aAuthVerifier } from "../a2a/node.js";
import { loadOrCreateA2aSigningIdentity, toJwsSigningIdentity } from "../a2a/signing-key.js";
import { loadProfile, ProfileError } from "../config/profile.js";
import { createMerchantManagementApiHandler } from "../http/merchant-management/api.js";
import { createMerchantFeedApiHandler } from "../http/merchant-feed-api.js";
import { createMerchantFollowApiHandler } from "../http/merchant-follow-api.js";
import { createMerchantEngagementApiHandler } from "../http/merchant-engagement-api.js";
import { createMerchantPrivacyApiHandler } from "../http/merchant-privacy-api.js";
import { MerchantImportDraftStore } from "../http/merchant-management/draft-store.js";
import { renderMerchantManagementPage } from "../http/merchant-management/page.js";
import { createTrustedWorkbenchPageHandler } from "../http/merchant-management/trusted-page.js";
import { MerchantManagementOperationStore } from "../http/merchant-management/operation-store.js";
import { WorkbenchConfirmationStore } from "../http/merchant-management/webauthn-confirmation.js";
import {
  WorkbenchReconciliationStore,
  WorkbenchReconciliationWorker,
  committedDecisionOutcomeResult,
  type OperationResult,
} from "../http/merchant-management/reconciliation-worker.js";
import { MutableServiceState } from "../http/merchant-management/service-state.js";
import { WorkbenchEventProjectionStore } from "../http/merchant-management/event-projection.js";
import { MerchantFeedStore } from "../merchant/feed-store.js";
import { MerchantFollowStore } from "../merchant/follow-store.js";
import { MerchantEngagementStore } from "../merchant/engagement-store.js";
import {
  recommendedRetentionPolicy,
  WorkbenchRetentionStore,
} from "../privacy/workbench-retention.js";
import { createBroadcastExecutors } from "../merchant/feed-executors.js";
import { isCurrentGrantAuthorization, MerchantGrantStore } from "../merchant/grant-store.js";
import { createGrantExecutors } from "../merchant/grant-executors.js";
import { MerchantPromotionStore } from "../merchant/promotion-store.js";
import { ClockSafetyStore, probeReferenceClock } from "../merchant/clock-safety.js";
import { createPromotionExecutors } from "../merchant/promotion-executors.js";
import { PromotionBroadcastWorkflowStore } from "../merchant/promotion-broadcast-workflow.js";
import { recoverPromotionBroadcastWorkflows } from "../merchant/promotion-broadcast-recovery.js";
import { createServiceControlExecutors } from "../merchant/service-control-executors.js";
import { calculateWorkbenchQuote } from "../merchant/quote-calculator.js";
import { WORKBENCH_CURRENCY_TABLE_VERSION } from "../merchant/application/money.js";
import { OnboardingStore } from "./onboarding/store.js";
import {
  ManagementError,
  type MerchantProductPage,
  type PageQuery,
} from "../merchant/application/service.js";
import {
  assembleMerchantRuntime,
  MerchantAssemblyError,
  type MerchantRuntimeAssembly,
} from "../mcp/merchant-runtime-assembly.js";
import {
  createMerchantHttpHandler,
  DEFAULT_MERCHANT_MCP_PATH as MCP_PATH,
} from "../mcp/merchant-server.js";
import { PRODUCT_VERSION } from "../product-cli.js";
import {
  CloudConfigError,
  assertNoDemoPriceFallback,
  describeCloudConfig,
  loadCloudConfig,
  type CloudRuntimeConfig,
} from "./config.js";
import { createChallengeResponder } from "./binding/runtime-challenge.js";
import type { BindingChallengeStore } from "./binding/proofs.js";
import { createCloudRouter, type CloudRequestListener } from "./http-router.js";
import {
  commitProductTable,
  createFileProductSource,
  loadProductTableSnapshot,
  ProductTableError,
  type CloudProductSourceHandle,
} from "./product-source.js";
import { runReadiness, type ReadinessCheckResult, type ReadinessReport } from "./readiness.js";

/** 云端 A2A 端点路径（设计 §8.2；与自托管根路径不同，便于同端口分发）。 */
export const CLOUD_A2A_PATH = "/a2a";

export interface CloudBootstrapOptions {
  env?: Record<string, string | undefined>;
  artifactRoot?: string;
  log?: (line: string) => void;
  /** 一次性挑战存储（缺省进程内；多实例/重启场景由调用方注入）。 */
  challengeStore?: BindingChallengeStore;
}

export interface CloudInstance {
  config: CloudRuntimeConfig;
  /** 已监听的单端口 http server。 */
  server: Server;
  /** 就绪检查入口（/readyz 与自检共用）。 */
  readiness: () => Promise<ReadinessReport>;
  close: () => Promise<void>;
}

/** 启动失败：code 稳定可判（配置错误/装配错误/端口占用等）。 */
export class CloudStartupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CloudStartupError";
    this.code = code;
  }
}

/**
 * 权威状态目录防覆盖（M0 事实 #2）：deploy 是目录上传覆盖同名文件，若状态目录
 * 里出现制品文件（package.json），说明制品被发布到了状态目录之上——权威状态
 * 已在不可知状态，必须拒绝启动而不是继续写。
 */
function assertDataDirNotClobbered(dataDir: string): void {
  const markers = ["package.json"];
  for (const marker of markers) {
    if (existsSync(path.join(dataDir, marker))) {
      throw new CloudStartupError(
        "DATA_DIR_CLOBBERED",
        `状态目录 ${dataDir} 内出现制品文件 ${marker}：制品可能被发布到状态目录之上，` +
          "权威状态不可信，拒绝启动",
      );
    }
  }
}

function loadOrCreateFeedCursorKey(dataDir: string): Buffer {
  const file = path.join(dataDir, "feed-cursor.key");
  const read = (): Buffer => {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
    if (key.length !== 32) {
      throw new CloudStartupError(
        "FEED_CURSOR_KEY_INVALID",
        "Feed cursor key must decode to 32 bytes",
      );
    }
    return key;
  };
  if (existsSync(file)) return read();
  const generated = randomBytes(32);
  try {
    writeFileSync(file, `${generated.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
    return generated;
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return read();
    throw new CloudStartupError("FEED_CURSOR_KEY_WRITE_FAILED", "cannot persist Feed cursor key");
  }
}

/** 权威存储可读写探针：写一行、读回、回滚（不留痕，也不依赖表结构）。 */
function probeAuthoritativeStorage(dataDir: string): ReadinessCheckResult {
  const dbPath = path.join(dataDir, "state.sqlite");
  if (!existsSync(dbPath)) {
    return { ok: false, code: "STORAGE_MISSING" };
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("BEGIN IMMEDIATE");
    db.exec("CREATE TABLE IF NOT EXISTS readyz_probe (id INTEGER PRIMARY KEY, at TEXT NOT NULL)");
    db.prepare("INSERT INTO readyz_probe (at) VALUES (?)").run(new Date().toISOString());
    const row = db.prepare("SELECT COUNT(*) AS count FROM readyz_probe").get() as
      { count?: number } | undefined;
    db.exec("ROLLBACK");
    return (row?.count ?? 0) > 0 ? { ok: true } : { ok: false, code: "STORAGE_READBACK_FAILED" };
  } catch {
    // 只回稳定码：细节（路径、锁持有者）留在启动日志，不对外暴露。
    return { ok: false, code: "STORAGE_WRITE_FAILED" };
  } finally {
    try {
      db?.close();
    } catch {
      // 关闭失败不改变结论
    }
  }
}

/**
 * 启动云端 Runtime。任何拒绝都抛 CloudStartupError / CloudConfigError，
 * 由入口非零退出并打印（绝不带着错误配置对外服务）。
 */
export async function bootstrapCloudRuntime(
  options: CloudBootstrapOptions = {},
): Promise<CloudInstance> {
  const log =
    options.log ??
    ((line: string): void => {
      process.stdout.write(line);
    });
  const config = loadCloudConfig(options.env ?? process.env, {
    ...(options.artifactRoot !== undefined ? { artifactRoot: options.artifactRoot } : {}),
  });

  // 1) 商家 profile：云端只接受 merchant 角色（buyer 侧由 Catalog/Buyer 通道承载）。
  let profile;
  try {
    profile = loadProfile(config.profilePath);
  } catch (err) {
    if (err instanceof ProfileError) {
      throw new CloudStartupError("PROFILE_LOAD_FAILED", err.message);
    }
    throw err;
  }
  if (profile.role !== "merchant") {
    throw new CloudStartupError(
      "PROFILE_NOT_MERCHANT",
      `云端 Runtime 需要 merchant profile（收到 role=${profile.role}）`,
    );
  }
  // 生产禁演示价回退（设计 §10.2）：演示价会让"商品源失联"看起来像有报价。
  assertNoDemoPriceFallback(profile);
  assertDataDirNotClobbered(config.dataDir);
  const serviceState = MutableServiceState.fromDeclared(options.env?.KIWI_CLOUD_SERVICE_STATE);

  // 2) 商家面装配（审批/策略/商品/RFQ/工具面）；认证走 OAuth（issuer = 公网 origin）。
  let assembly: MerchantRuntimeAssembly;
  let feedStoreForExecutors: MerchantFeedStore | undefined;
  let grantStoreForExecutors: MerchantGrantStore | undefined;
  let promotionStoreForExecutors: MerchantPromotionStore | undefined;
  let promotionWorkflowStoreForExecutors: PromotionBroadcastWorkflowStore | undefined;
  let readinessForServiceControl:
    (() => Promise<{ ready: boolean; checks: Record<string, { ok: boolean }> }>) | undefined;
  try {
    assembly = await assembleMerchantRuntime({
      profile,
      dataDir: config.dataDir,
      host: config.bindHost,
      port: config.port,
      mcpPath: MCP_PATH,
      authMode: "oauth",
      issuer: config.publicOrigin,
      requireCommittedProductDecisions: true,
      extraExecutors: [
        ...createBroadcastExecutors({
          merchantId: profile.owner_id,
          getStore: () => feedStoreForExecutors,
          authorizeExecution: (args) => {
            const authorization = recordValue(args["authorization"]);
            const actorId = String(authorization["actor_id"] ?? "");
            const grants = grantStoreForExecutors;
            if (
              grants === undefined ||
              !isCurrentGrantAuthorization(grants, {
                merchantId: profile.owner_id,
                actorId,
                action: "broadcast.draft",
                snapshot: authorization,
              })
            ) {
              throw new Error("broadcast draft authorization is missing");
            }
          },
          onPublished: (args) => {
            const workflowId =
              typeof args["workflow_id"] === "string" ? args["workflow_id"] : undefined;
            if (workflowId !== undefined) {
              const workflows = promotionWorkflowStoreForExecutors;
              if (workflows === undefined) {
                throw new Error("promotion workflow authority is unavailable");
              }
              workflows.markCompleted(profile.owner_id, workflowId);
            }
          },
        }),
        ...createGrantExecutors({
          merchantId: profile.owner_id,
          getStore: () => grantStoreForExecutors,
        }),
        ...createPromotionExecutors({
          merchantId: profile.owner_id,
          getStore: () => promotionStoreForExecutors,
          getWorkflowStore: () => promotionWorkflowStoreForExecutors,
          prepareBroadcast: async ({ broadcast, authorization, workflowId }) => {
            const actorId = String(authorization["actor_id"] ?? "");
            const grants = grantStoreForExecutors;
            if (
              grants === undefined ||
              !isCurrentGrantAuthorization(grants, {
                merchantId: profile.owner_id,
                actorId,
                action: "broadcast.draft",
                snapshot: authorization,
              })
            ) {
              throw new Error("broadcast draft authorization changed after promotion approval");
            }
            const prepared = await assembly.service.prepareBroadcastPublish({
              broadcast,
              authorization,
              workflowId,
              reason: "promotion workflow generated broadcast draft",
            });
            return prepared.candidate.candidate_id;
          },
        }),
        ...createServiceControlExecutors({
          state: serviceState,
          readiness: async () => {
            if (readinessForServiceControl === undefined) {
              throw new Error("readiness provider is not configured");
            }
            return await readinessForServiceControl();
          },
        }),
      ],
      log,
    });
  } catch (err) {
    if (err instanceof MerchantAssemblyError) {
      throw new CloudStartupError(`ASSEMBLY_${err.code}`, err.message);
    }
    throw err;
  }

  // 3) A2A 核心：签名身份 + 入站认证（弱模式已在配置层拒绝）。
  //
  // Runtime 身份**始终**创建（M2 §6.3：Runtime 首次启动生成持久密钥，公钥摘要
  // 绑定到开通意图）。即使入站认证用 bearer，绑定/挑战也需要这把持久密钥；
  // 公钥随 Agent Card 公开（非秘密），私钥留在状态目录、不出进程。
  const signingKeyDir = config.dataDir;
  const signingIdentity = loadOrCreateA2aSigningIdentity(signingKeyDir, config.publicOrigin);
  const bearerToken =
    config.a2aAuth.mode === "bearer"
      ? (options.env ?? process.env)[config.a2aAuth.tokenEnv]
      : undefined;
  const authVerifier = createA2aAuthVerifier({
    mode: config.a2aAuth.mode,
    ...(bearerToken !== undefined ? { bearerToken } : {}),
    signingKeyDir,
    signingKeyId: signingIdentity?.keyid ?? config.publicOrigin,
    advertisedBase: config.publicOrigin,
    // 云端必须按声明 origin 重建目标 URI：平台网关会改写入站 Host（M0 事实 #4）。
    authoritySource: "declared",
  });
  // 商品源：配置文件给了商品表就用"商家上传商品表"路径（设计 §10.1），
  // 否则沿用 HTTP 商品源（shopping-cli 开放层）。两条路径都不含演示价回退。
  const fileProductSource: CloudProductSourceHandle | undefined =
    config.productsFile !== undefined
      ? createFileProductSource({ file: config.productsFile, merchantId: profile.owner_id })
      : undefined;
  // 服务可取用性闸门（M4 §5.4/T012 + BD-02）：由可变服务状态驱动——初始值来自
  // 操作者显式环境声明，之后可经管理 API 暂停/恢复（owner + 确认 + 就绪门）。
  //
  // 为什么不接就绪检查：就绪语义与业务可取用性**不是一回事**——就绪里含"探针 SKU
  // 是否配置/商品数据是否新鲜"这类核对项，把它们当成"停业"会让正常营业的商家因探针
  // 没配而被拒绝接待（实测：接就绪后 T018 与"过期商品表"用例当场被拒）。正确映射要
  // 与"过期商品该不该停业"一起决定，属暂停/撤回控制落地时的事；在那之前这里只认
  // **操作者显式声明**的状态，绝不替商家判断。
  const serviceAvailability = {
    check: (): { accepting: true } | { accepting: false; state: string; reason: string } =>
      serviceState.gateCheck(),
  };
  const core = createA2aNodeCore({
    profile,
    advertisedBase: config.publicOrigin,
    a2aPath: CLOUD_A2A_PATH,
    dataDir: config.dataDir,
    authVerifier,
    ...(signingIdentity !== undefined ? { signingIdentity } : {}),
    ...(fileProductSource !== undefined ? { productSource: fileProductSource.source } : {}),
    ...(serviceAvailability !== undefined ? { serviceAvailability } : {}),
    promotionPrice: ({ sku, quantity }) => {
      const promotion = promotionStoreForExecutors?.activeForSku(
        profile.owner_id,
        sku,
        quantity,
      )[0];
      return promotion === undefined
        ? undefined
        : {
            promotionId: promotion.promotion_id,
            revision: promotion.revision,
            currency: promotion.unit_price.currency,
            amountMinor: promotion.unit_price.amount_minor,
            endsAt: promotion.ends_at,
          };
    },
  });

  // 4) 就绪检查（无敏感值；stale 商品/未配置探针 SKU 都算未就绪，不冒充可用）。
  const probeSku = config.readinessSku;
  const readiness = async (): Promise<ReadinessReport> =>
    await runReadiness({
      timeoutMs: config.readinessTimeoutMs,
      identity: () => {
        if (config.a2aAuth.mode === "signature") {
          return signingIdentity !== undefined
            ? { ok: true }
            : { ok: false, code: "IDENTITY_SIGNING_KEY_MISSING" };
        }
        return bearerToken !== undefined
          ? { ok: true }
          : { ok: false, code: "IDENTITY_BEARER_TOKEN_MISSING" };
      },
      storage: () => probeAuthoritativeStorage(config.dataDir),
      products: async () => {
        if (core.productSource === undefined) return { ok: false, code: "PRODUCTS_SOURCE_ABSENT" };
        if (probeSku === undefined || probeSku === "") {
          // 未配置探针 SKU：M1 必须用授权真实测试商品，不能凭"进程活着"判就绪。
          return { ok: false, code: "PRODUCTS_PROBE_SKU_UNSET" };
        }
        if (fileProductSource !== undefined) {
          // 文件式商品源：只回可用性原因码（不含价格）。
          const check = fileProductSource.describeSku(probeSku);
          return check.available
            ? { ok: true }
            : { ok: false, code: check.code ?? "PRODUCTS_UNAVAILABLE" };
        }
        try {
          const product = await core.productSource.getProduct(probeSku);
          return product !== undefined ? { ok: true } : { ok: false, code: "PRODUCTS_NOT_FOUND" };
        } catch {
          return { ok: false, code: "PRODUCTS_UNREACHABLE" };
        }
      },
      policy: () => {
        const current = assembly.policy();
        return current.digest !== "" ? { ok: true } : { ok: false, code: "POLICY_EMPTY" };
      },
    });
  readinessForServiceControl = async () => {
    const report = await readiness();
    return { ready: report.ready, checks: report.checks };
  };

  // 4.5) BD-02：私有管理 API（/merchant/api/*）。会话与 /admin 同源；业务经共用
  //      MerchantApplicationService；权威操作记录落 state.sqlite。管理面未装配
  //      （无 admin 会话）时不挂载——/merchant/api 维持别名/404 旧行为。
  const adminOptions = assembly.serverOptions.admin;
  const productsFilePath = config.productsFile;
  const applyPolicyOverride = assembly.service.policyApplier;
  let managementDb: DatabaseSync | undefined;
  let merchantApiHandler: CloudRequestListener | undefined;
  let publicFeedHandler: CloudRequestListener | undefined;
  let buyerHandler: CloudRequestListener | undefined;
  let reconciliationTimer: ReturnType<typeof setInterval> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  if (adminOptions !== undefined) {
    managementDb = new DatabaseSync(path.join(config.dataDir, "state.sqlite"));
    serviceState.attachPersistence(managementDb, profile.owner_id);
    const workbenchConfirmations = new WorkbenchConfirmationStore({ db: managementDb });
    const reconciliationStore = new WorkbenchReconciliationStore({ db: managementDb });
    const clockSafety = new ClockSafetyStore({ db: managementDb, alerts: reconciliationStore });
    const workbenchCursorKey = loadOrCreateFeedCursorKey(config.dataDir);
    const feedStore = new MerchantFeedStore({
      db: managementDb,
      cursorKey: workbenchCursorKey,
    });
    const grantStore = new MerchantGrantStore({ db: managementDb });
    const followStore = new MerchantFollowStore({ db: managementDb });
    const engagementStore = new MerchantEngagementStore({ db: managementDb });
    const retentionStore = new WorkbenchRetentionStore({ db: managementDb });
    const retentionProcessor = String(
      (options.env ?? process.env).KIWI_RETENTION_PROCESSOR ?? "",
    ).trim();
    const retentionBasis = String((options.env ?? process.env).KIWI_RETENTION_BASIS ?? "").trim();
    const retentionReviewAt = String(
      (options.env ?? process.env).KIWI_RETENTION_REVIEW_AT ?? "",
    ).trim();
    if (retentionProcessor !== "" && retentionBasis !== "" && retentionReviewAt !== "") {
      retentionStore.configurePolicy(
        recommendedRetentionPolicy({
          processor: retentionProcessor,
          basis: retentionBasis,
          reviewAt: retentionReviewAt,
        }),
      );
    }
    const promotionStore = new MerchantPromotionStore({ db: managementDb, clockSafety });
    const promotionWorkflowStore = new PromotionBroadcastWorkflowStore({ db: managementDb });
    const eventProjectionStore = new WorkbenchEventProjectionStore({
      db: managementDb,
      cursorKey: workbenchCursorKey,
    });
    feedStoreForExecutors = feedStore;
    grantStoreForExecutors = grantStore;
    promotionStoreForExecutors = promotionStore;
    promotionWorkflowStoreForExecutors = promotionWorkflowStore;

    const referenceTimeUrl = String(
      (options.env ?? process.env).KIWI_REFERENCE_TIME_URL ?? "",
    ).trim();
    if (referenceTimeUrl !== "") {
      const referenceUrl = requireSecureProbeUrl(referenceTimeUrl, "KIWI_REFERENCE_TIME_URL");
      let clockProbeRunning = false;
      const probeClock = (): void => {
        if (clockProbeRunning) return;
        clockProbeRunning = true;
        void probeReferenceClock(clockSafety, {
          merchantId: profile.owner_id,
          referenceUrl,
        })
          .catch(() => {
            log("[kiwi-cloud] reference clock probe failed; prior clock-safety state retained\n");
          })
          .finally(() => {
            clockProbeRunning = false;
          });
      };
      clockTimer = setInterval(probeClock, 60_000);
      clockTimer.unref();
      probeClock();
    } else {
      log(
        "[kiwi-cloud] KIWI_REFERENCE_TIME_URL is unset; time-sensitive promotion writes remain paused\n",
      );
    }

    await recoverPromotionBroadcastWorkflows({
      merchantId: profile.owner_id,
      workflows: promotionWorkflowStore,
      promotions: promotionStore,
      grants: grantStore,
      listPending: () => adminOptions.surface.listPending(),
      getCandidate: (candidateId) => adminOptions.surface.getCandidate?.(candidateId),
      prepareBroadcast: async ({ broadcast, authorization, workflowId }) => {
        const prepared = await assembly.service.prepareBroadcastPublish({
          broadcast,
          authorization,
          workflowId,
          reason: "startup recovery for published promotion",
        });
        return prepared.candidate.candidate_id;
      },
    });
    publicFeedHandler = createMerchantFeedApiHandler({
      merchantId: profile.owner_id,
      store: feedStore,
    });
    const resolveVerifiedBuyer = async (
      request: import("node:http").IncomingMessage,
      body?: Buffer,
    ) => {
      const socketTls = request.socket as { encrypted?: boolean };
      const result = await authVerifier.verify({
        remoteAddress: request.socket.remoteAddress,
        authorizationHeader: request.headers.authorization,
        method: request.method ?? "",
        url: request.url ?? "",
        scheme: socketTls.encrypted === true ? "https" : "http",
        headers: request.headers,
        body,
      });
      if (
        !result.authenticated ||
        result.identityVerified !== true ||
        typeof result.identity !== "string" ||
        result.identity.trim() === ""
      ) {
        return undefined;
      }
      return {
        merchantId: profile.owner_id,
        buyerPrincipalId: result.identity,
      };
    };
    const followHandler = createMerchantFollowApiHandler({
      merchantId: profile.owner_id,
      store: followStore,
      resolveBuyer: resolveVerifiedBuyer,
    });
    const engagementHandler = createMerchantEngagementApiHandler({
      merchantId: profile.owner_id,
      store: engagementStore,
      broadcastExists: (broadcastId) =>
        feedStore.getBroadcast(profile.owner_id, broadcastId) !== undefined,
      resolveBuyer: async (request, body) => await resolveVerifiedBuyer(request, body),
    });
    const privacyHandler = createMerchantPrivacyApiHandler({
      merchantId: profile.owner_id,
      store: retentionStore,
      resolveBuyer: resolveVerifiedBuyer,
    });
    buyerHandler = (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://buyer.internal").pathname;
      if (pathname === "/buyer/v1/follow") followHandler(request, response);
      else if (pathname.startsWith("/buyer/v1/privacy-requests")) {
        privacyHandler(request, response);
      } else engagementHandler(request, response);
    };
    merchantApiHandler = createMerchantManagementApiHandler({
      merchantId: profile.owner_id,
      // 单代次实例（与 M2 挑战应答的 currentGeneration 同值）；代次切换属 BD-05。
      generation: () => 1,
      runtimeVersion: PRODUCT_VERSION,
      sessions: adminOptions.sessions,
      ...(adminOptions.secureCookies === true ? { secureCookies: true } : {}),
      allowedOrigins: [config.publicOrigin],
      listPending: () => adminOptions.surface.listPending(),
      mintCandidateConfirmation: (input) => adminOptions.store.createConfirmation(input),
      executeDecision: async (input) => {
        if (input.approve) {
          await adminOptions.surface.executeApproved(
            input.candidateId,
            input.actorId,
            input.confirmationRef,
          );
        } else {
          await adminOptions.surface.rejectCandidate(
            input.candidateId,
            input.actorId,
            input.confirmationRef,
          );
        }
      },
      policy: () => {
        const current = assembly.policy();
        return current.digest === ""
          ? undefined
          : { version: current.version, digest: current.digest };
      },
      // 商品投影/导入：仅在配置了商品表文件时可用；ProductTableError → 503
      //（不让「表不可读」伪装成「无商品」）。价格即商品表的 major units（元），
      // 与 MerchantProductSource 契约同单位，不经换算（金额单位红线）。
      ...(fileProductSource !== undefined && productsFilePath !== undefined
        ? {
            products: async (query: PageQuery): Promise<MerchantProductPage> => {
              let records;
              try {
                records = fileProductSource.list();
              } catch (err) {
                if (err instanceof ProductTableError) {
                  throw new ManagementError(
                    "unavailable",
                    `product table unavailable (${err.code})`,
                  );
                }
                throw err;
              }
              const offset =
                query.cursor !== undefined
                  ? Math.max(0, Number.parseInt(query.cursor, 10) || 0)
                  : 0;
              const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
              const nowMs = Date.now();
              const items = records.slice(offset, offset + limit).map((record) => ({
                sku: record.sku,
                title: record.title,
                currency: record.currency,
                price: record.price,
                price_unit: record.unit,
                min_order_qty: record.moq ?? null,
                valid_until: record.valid_until,
                updated_at: record.updated_at,
                status:
                  record.status === "paused"
                    ? "paused"
                    : Date.parse(record.valid_until) < nowMs
                      ? "expired"
                      : "active",
              }));
              return {
                items,
                next_cursor: offset + limit < records.length ? String(offset + limit) : null,
              };
            },
            productsImport: {
              currentTable: () => {
                const snapshot = loadProductTableSnapshot(productsFilePath, profile.owner_id);
                return { digest: snapshot.digest, records: snapshot.records };
              },
              commit: (table: Parameters<typeof commitProductTable>[2]) =>
                commitProductTable(productsFilePath, profile.owner_id, table),
            },
          }
        : {}),
      ...(applyPolicyOverride !== undefined
        ? {
            policyApply: async (patch: Record<string, unknown>) => {
              const applied = await applyPolicyOverride(patch);
              return { version: applied.version, digest: applied.digest };
            },
          }
        : {}),
      drafts: new MerchantImportDraftStore({
        db: managementDb,
        now: () => new Date().toISOString(),
      }),
      operations: new MerchantManagementOperationStore({ db: managementDb }),
      // M4 §5.4：开通向导与 /admin/onboarding 读**同一份** OnboardingStore（同一个
      // state.sqlite），不复制状态机。`platformEvidence` 适配器**故意不配**——平台侧
      // 取回执的能力尚未落地，因此需要权威证据的步骤会明确 503（不推进），
      // 绝不用请求体自报的证据顶上（T029）。
      onboarding: { store: new OnboardingStore(managementDb) },
      workbenchConfirmations,
      workbenchReconciliation: reconciliationStore,
      workbenchEvents: eventProjectionStore,
      followerSummary: () => followStore.activeCount(profile.owner_id),
      engagementSummary: () => engagementStore.summary(profile.owner_id),
      workbenchRetention: retentionStore,
      workbenchFeed: feedStore,
      workbenchGrants: grantStore,
      workbenchPromotions: promotionStore,
      promotionBroadcastWorkflows: promotionWorkflowStore,
      ...(adminOptions.surface.listA2aNegotiations !== undefined &&
      adminOptions.surface.getA2aNegotiation !== undefined
        ? {
            negotiations: {
              list: (limit?: number) => adminOptions.surface.listA2aNegotiations!(limit),
              get: (negotiationId: string) =>
                adminOptions.surface.getA2aNegotiation!(negotiationId),
            },
          }
        : {}),
      ...(adminOptions.surface.listExactProducts !== undefined &&
      adminOptions.surface.getExactProduct !== undefined
        ? {
            exactProducts: {
              list: () => adminOptions.surface.listExactProducts!(),
              get: (sku: string) => adminOptions.surface.getExactProduct!(sku),
            },
          }
        : {}),
      ...(adminOptions.surface.getExactProduct !== undefined
        ? {
            quotePreview: async (sku: string, quantity: number) => {
              const product = await adminOptions.surface.getExactProduct!(sku);
              const promotions = promotionStore.activeForSku(profile.owner_id, sku, quantity);
              if (product.currency_table_version !== WORKBENCH_CURRENCY_TABLE_VERSION) {
                throw new Error("exact product currency table version mismatch");
              }
              const privateFloorMinor = assembly.privateFloorMinor(sku, product.currency);
              return calculateWorkbenchQuote({
                base: {
                  currency: product.currency,
                  amount_minor: product.price_minor,
                  currency_table_version: WORKBENCH_CURRENCY_TABLE_VERSION,
                },
                quantity,
                promotions,
                ...(privateFloorMinor !== undefined ? { privateFloorMinor } : {}),
              });
            },
          }
        : {}),
      ...(adminOptions.surface.prepareBroadcastPublish !== undefined
        ? { prepareBroadcastPublish: adminOptions.surface.prepareBroadcastPublish }
        : {}),
      ...(adminOptions.surface.prepareInventoryUpdate !== undefined
        ? { prepareInventoryUpdate: adminOptions.surface.prepareInventoryUpdate }
        : {}),
      ...(adminOptions.surface.prepareListingChange !== undefined
        ? { prepareListingChange: adminOptions.surface.prepareListingChange }
        : {}),
      ...(adminOptions.surface.prepareExactProductCreate !== undefined
        ? { prepareExactProductCreate: adminOptions.surface.prepareExactProductCreate }
        : {}),
      ...(adminOptions.surface.prepareExactProductMoneyUpdate !== undefined
        ? {
            prepareExactProductMoneyUpdate: adminOptions.surface.prepareExactProductMoneyUpdate,
          }
        : {}),
      ...(adminOptions.surface.prepareServiceResume !== undefined
        ? { prepareServiceResume: adminOptions.surface.prepareServiceResume }
        : {}),
      ...(adminOptions.surface.prepareBroadcastRevise !== undefined
        ? { prepareBroadcastRevise: adminOptions.surface.prepareBroadcastRevise }
        : {}),
      ...(adminOptions.surface.prepareBroadcastWithdraw !== undefined
        ? { prepareBroadcastWithdraw: adminOptions.surface.prepareBroadcastWithdraw }
        : {}),
      ...(adminOptions.surface.prepareGrantCreate !== undefined
        ? { prepareGrantCreate: adminOptions.surface.prepareGrantCreate }
        : {}),
      ...(adminOptions.surface.prepareGrantRevoke !== undefined
        ? { prepareGrantRevoke: adminOptions.surface.prepareGrantRevoke }
        : {}),
      ...(adminOptions.surface.preparePromotionPublish !== undefined
        ? { preparePromotionPublish: adminOptions.surface.preparePromotionPublish }
        : {}),
      ...(adminOptions.surface.preparePromotionWithdraw !== undefined
        ? { preparePromotionWithdraw: adminOptions.surface.preparePromotionWithdraw }
        : {}),
      serviceState,
      readiness: async () => {
        const report = await readiness();
        return { ready: report.ready, checks: report.checks };
      },
      log,
    });

    const worker = new WorkbenchReconciliationWorker(reconciliationStore, {
      workerId: `runtime:${profile.agent_id}`,
      merchantId: profile.owner_id,
      execute: async (lease): Promise<OperationResult> => {
        if (adminOptions.surface.executeCommittedDecision === undefined) {
          return { status: "failed", error: "committed-decision execution is not configured" };
        }
        try {
          const authorization = workbenchConfirmations.authorizationSnapshotForOperation(
            lease.operationId,
          );
          if (authorization !== undefined) {
            const action = String(authorization["action"] ?? "");
            const allowed =
              action === "grants.manage" || action === "service.resume"
                ? authorization["actor_id"] === lease.actorId &&
                  authorization["actor_role"] === "owner"
                : isCurrentGrantAuthorization(grantStore, {
                    merchantId: profile.owner_id,
                    actorId: lease.actorId,
                    action:
                      action === "product.decide" || action === "product.create"
                        ? action
                        : "broadcast.decide",
                    ...(action === "product.decide"
                      ? {
                          resourceType: "product" as const,
                          resourceIds: Array.isArray(authorization["resource_ids"])
                            ? authorization["resource_ids"].map((value) => String(value))
                            : [],
                        }
                      : action === "product.create"
                        ? { resourceType: "merchant" as const }
                        : {}),
                    snapshot: authorization,
                  });
            if (!allowed) {
              return { status: "failed", error: "Workbench decision authorization was revoked" };
            }
          }
          const outcome = await adminOptions.surface.executeCommittedDecision(
            {
              operationId: lease.operationId,
              candidateId: lease.candidateId,
              actorId: lease.actorId,
              decision: lease.decision,
            },
            workbenchConfirmations,
          );
          return committedDecisionOutcomeResult(outcome);
        } catch (error) {
          // The executor may have crossed an external side-effect boundary before throwing.
          // Never resubmit: persist UNKNOWN and let the query path reconcile the same operation.
          return {
            status: "unknown",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      query: async (lease): Promise<OperationResult> => {
        if (adminOptions.surface.getCandidate === undefined) {
          return { status: "failed", error: "candidate query is not configured" };
        }
        const candidate = adminOptions.surface.getCandidate(
          reconciliationStore.candidateIdForOperation(lease.operationId) ?? "",
        );
        if (candidate === undefined) return { status: "failed", error: "candidate is unavailable" };
        if (candidate.status === "executed" || candidate.status === "rejected") {
          return { status: "succeeded" };
        }
        if (candidate.status === "expired" || candidate.status === "superseded") {
          return { status: "failed", error: `candidate ended as ${candidate.status}` };
        }
        return { status: "unknown", error: `candidate remains ${candidate.status}` };
      },
    });
    let workerRunning = false;
    const tick = (): void => {
      if (workerRunning) return;
      workerRunning = true;
      void worker
        .runOnce()
        .catch((error: unknown) => {
          log(
            `[kiwi-cloud] Workbench reconciliation tick failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        })
        .finally(() => {
          workerRunning = false;
        });
    };
    reconciliationTimer = setInterval(tick, 5_000);
    reconciliationTimer.unref();
    tick();
  }

  // 4.6) 商家工作台首页（/merchant/ 静态壳；数据经 /merchant/api/* 认证获取）。
  const merchantHomePage: CloudRequestListener = (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderMerchantManagementPage());
  };

  // 5) 单端口路由：A2A 面 / 商家面 / 管理面 / 探针，各自鉴权边界不变。
  const merchantHandler = createMerchantHttpHandler(assembly.serverOptions);
  const router = createCloudRouter({
    a2aHandler: core.server.handler(),
    merchantHandler: merchantHandler.handler,
    ...(merchantApiHandler !== undefined ? { merchantApiHandler } : {}),
    ...(publicFeedHandler !== undefined ? { publicFeedHandler } : {}),
    ...(buyerHandler !== undefined ? { buyerHandler } : {}),
    trustedPageHandler: createTrustedWorkbenchPageHandler(),
    merchantHomePage,
    readiness,
    a2aPaths: [CLOUD_A2A_PATH],
    // 绑定挑战应答（M2 §6.3）：只签发给本实例的受限结构挑战，一次性、有速率上限。
    challengeHandler: createChallengeResponder({
      signingIdentity: toJwsSigningIdentity(signingIdentity),
      expectedMerchantId: profile.owner_id,
      expectedAgentId: profile.agent_id,
      currentGeneration: 1,
      ...(options.challengeStore !== undefined ? { store: options.challengeStore } : {}),
    }),
    version: PRODUCT_VERSION,
  });
  const server = createServer(router);
  server.on("clientError", () => {
    // 畸形客户端流量（中止的 socket 等）不得让服务崩溃。
  });

  // 6) 严格监听：端口被占用即失败，绝不换端口（T013）。
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: { code?: string }): void => {
        reject(
          new CloudStartupError(
            err.code === "EADDRINUSE" ? "PORT_IN_USE" : "LISTEN_FAILED",
            `监听 ${config.bindHost}:${config.port} 失败（${err.code ?? "unknown"}）：` +
              "云端不换端口——请确认端口未被占用且与平台注入值一致",
          ),
        );
      };
      server.once("error", onError);
      server.listen(config.port, config.bindHost, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  } catch (err) {
    if (reconciliationTimer !== undefined) clearInterval(reconciliationTimer);
    if (clockTimer !== undefined) clearInterval(clockTimer);
    managementDb?.close();
    core.close();
    await assembly.close().catch(() => undefined);
    throw err;
  }

  const summary = describeCloudConfig(config);
  log(
    `[kiwi-cloud] listening ${config.bindHost}:${config.port}` +
      `（origin=${summary.publicOrigin}，a2a=${CLOUD_A2A_PATH}，auth=${summary.a2aAuth}，` +
      `merchant=${assembly.authLabel}，version=${PRODUCT_VERSION}）\n`,
  );

  // 自检：把就绪结论写进启动日志（不含敏感值）；不就绪只告警不拒绝启动
  // （M1 允许"进程活着但未就绪"——探针语义由 /readyz 精确表达）。
  try {
    const report = await readiness();
    log(
      `[kiwi-cloud] readyz=${report.ready ? "ready" : "not-ready"}` +
        ` checks=${JSON.stringify(report.checks)}\n`,
    );
  } catch {
    log("[kiwi-cloud] readyz 自检异常（不影响启动）\n");
  }

  return {
    config,
    server,
    readiness,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await merchantHandler.close().catch(() => undefined);
      if (reconciliationTimer !== undefined) clearInterval(reconciliationTimer);
      if (clockTimer !== undefined) clearInterval(clockTimer);
      core.close();
      await assembly.close().catch(() => undefined);
      managementDb?.close();
    },
  };
}

/** 供入口脚本复用的错误渲染：稳定码 + 可读消息，不含凭据。 */
export function renderStartupFailure(err: unknown): string {
  if (err instanceof CloudConfigError || err instanceof CloudStartupError) {
    return `[kiwi-cloud] 启动失败（${err.code}）：${err.message}\n`;
  }
  if (err instanceof Error) return `[kiwi-cloud] 启动失败：${err.message}\n`;
  return `[kiwi-cloud] 启动失败：${String(err)}\n`;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("broadcast authorization snapshot is missing");
  }
  return value as Record<string, unknown>;
}

function requireSecureProbeUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudStartupError("INVALID_CONFIG", `${field} must be a valid URL`);
  }
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new CloudStartupError("INVALID_CONFIG", `${field} must use HTTPS unless it is loopback`);
  }
  return url;
}
