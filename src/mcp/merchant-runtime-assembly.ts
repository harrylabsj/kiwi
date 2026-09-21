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
 * 商家 Runtime 装配（CLI 与云端入口共用）。
 *
 * 从 `kiwi merchant mcp serve` 抽出：装配 = OAuth/令牌认证 + 审批候选 +
 * 账本/幂等 + 商品源 + 策略 + 询报价子服务 + 管理面 + MCP 工具面，产出
 * `MerchantMcpServerOptions`（挂载方式由调用方决定：CLI 自己 listen，云端把
 * handler 挂进单端口路由，设计 §8.2）。
 *
 * 行为与 CLI 原路径一致，只是把"进程退出码"改为抛出 MerchantAssemblyError，
 * 由调用方决定是退出还是拒绝启动。装配不监听端口、不注册目录、不启动对话。
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isLoopbackHost } from "../a2a/client/url-policy.js";
import { ensurePathsForDir, openAgentDatabase } from "../agent/agent-db.js";
import { WriteApprovalCandidateStore } from "../agent/merchant/action-candidate.js";
import { ProfileCredentialBroker } from "../agent/merchant/credential-broker.js";
import { FakeMerchantClient, fakeMerchantProduct } from "../agent/merchant/fake-merchant-client.js";
import { DefaultMerchantIntelligenceBackend } from "../agent/merchant/intelligence/default-backend.js";
import { HttpMerchantClient } from "../agent/merchant/merchant-client.js";
import type { MerchantClient } from "../agent/merchant/types.js";
import { MemoryStore } from "../agent/memory/store.js";
import { PrivateVault } from "../agent/memory/vault.js";
import { MerchantOAuthVerifier } from "../auth/merchant-authorization.js";
import { MerchantOAuthServer, MerchantOAuthStore } from "../auth/merchant-oauth.js";
import { MerchantAdminSessions } from "../auth/merchant-sessions.js";
import { OnboardingStore } from "../cloud/onboarding/store.js";
import { rfqAdminSurface } from "../merchant-admin/rfq-page.js";
import { merchantAdminSurface } from "../merchant-admin/pending-page.js";
import { MerchantOperationStore } from "../merchant-core/operations.js";
import { MerchantPolicyRuntime } from "../merchant-core/policy-runtime.js";
import { RfqArtifactStore, ensureArtifactRoot } from "../merchant-core/rfq/artifacts.js";
import { MerchantClientCommerceDataSource } from "../merchant-core/rfq/data-source-adapter.js";
import { rfqPolicyConfigFromMerchantPolicy } from "../merchant-core/rfq/policy.js";
import { RfqReleaseCoordinator } from "../merchant-core/rfq/release-coordinator.js";
import { RfqRepository } from "../merchant-core/rfq/repository.js";
import { MerchantRfqService } from "../merchant-core/rfq/service.js";
import { MerchantCoreService } from "../merchant-core/service.js";
import type { CommandExecutor } from "../merchant-core/executor.js";
import { createExactProductExecutors } from "../merchant/exact-product-executors.js";
import {
  assertMerchantMcpAuthPolicy,
  CompositeMerchantMcpVerifier,
  PairedCredentialVerifier,
  resolveMerchantMcpVerifier,
} from "./merchant-auth.js";
import type { MerchantMcpAuthVerifier } from "./merchant-auth.js";
import { buildRfqPresentationResources } from "./merchant-rfq-resources.js";
import { buildRfqMcpTools } from "./merchant-rfq-tools.js";
import { buildMerchantPresentationResources } from "./merchant-resources.js";
import type { MerchantMcpServerOptions } from "./merchant-server.js";
import type { AgentProfile } from "../config/profile.js";
import { PRODUCT_VERSION } from "../product-cli.js";
import { isFakeProvider } from "../config/provider-kind.js";

/** 装配失败：code 稳定可判，message 面向操作者。 */
export class MerchantAssemblyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MerchantAssemblyError";
    this.code = code;
  }
}

export interface MerchantRuntimeAssemblyOptions {
  profile: AgentProfile;
  /** 商家数据根目录（显式传入；本函数不推导路径）。 */
  dataDir: string;
  /** 监听地址：仅用于认证策略判定（loopback 与公网判据不同）。 */
  host: string;
  /** 监听端口：仅用于 loopback 形态的 OAuth issuer 推导。 */
  port: number;
  /** MCP 端点路径（同时决定 OAuth resource）。 */
  mcpPath: string;
  /**
   * 控制面（Catalog）当前是否可达。缺省 false——"不知道"不等于"正常"，
   * 管理入口据此要求商家先对账（M4 §5.4）。
   */
  catalogReachable?: boolean;
  /** 商家面认证模式：oauth（自建授权服务器）或 token（静态 Bearer，过渡）。 */
  authMode: "oauth" | "token";
  /** oauth 模式的 issuer（生产 https 公网地址；缺省按 loopback 推导）。 */
  issuer?: string;
  /** token 模式承载令牌的环境变量名。 */
  tokenEnv?: string;
  /** 日志出口（缺省 stderr）。 */
  log?: (line: string) => void;
  /** Extra Workbench executors fixed at startup. */
  extraExecutors?: CommandExecutor[];
  /** Require committed Workbench WebAuthn decisions for product writes. */
  requireCommittedProductDecisions?: boolean;
}

export interface MerchantRuntimeAssembly {
  /** 交给 startMerchantMcpServer / createMerchantHttpHandler 的装配结果。 */
  serverOptions: MerchantMcpServerOptions;
  service: MerchantCoreService;
  /** 恢复的待批准写命令数量（启动日志用）。 */
  recovered: { recovered: number };
  authMode: "oauth" | "token";
  /** 认证模式的人类可读标签（不含凭据）。 */
  authLabel: string;
  /** 运行中生效策略的版本与摘要（就绪检查用；不含策略内容）。 */
  policy: () => { version: number; digest: string };
  /** 关闭装配持有的数据库连接（不涉及 http server）。 */
  close: () => Promise<void>;
}

/** 读能力探测落盘记录的 listing_pause（F08 接线；记录缺失/损坏 → undefined 不判定）。 */
function probeCapabilitiesListingPause(dataDir: string): boolean | undefined {
  try {
    const probe = JSON.parse(readFileSync(path.join(dataDir, "capability-probe.json"), "utf8")) as {
      capabilities?: { listing_pause?: boolean };
    };
    return probe.capabilities?.listing_pause;
  } catch {
    return undefined;
  }
}

export async function assembleMerchantRuntime(
  options: MerchantRuntimeAssemblyOptions,
): Promise<MerchantRuntimeAssembly> {
  const profile = options.profile;
  const host = options.host;
  const port = options.port;
  const mcpPath = options.mcpPath;
  const authMode = options.authMode;
  const log =
    options.log ??
    ((line: string): void => {
      process.stderr.write(line);
    });

  // 认证模式（V2）：oauth = 自建 OAuth 2.1 授权服务器（正式）；
  // token = V1 静态 Bearer（过渡）。fail-closed 判定见下。
  let oauth: MerchantOAuthServer | undefined;
  let oauthDb: DatabaseSync | undefined;
  let oauthStore: MerchantOAuthStore | undefined;
  let verifier: MerchantMcpAuthVerifier | undefined;
  // 会话与一次性确认凭证的存储**与认证模式无关**：写操作确认页（/admin/*）
  // 在两种模式下都挂载——网关路由形态要求实例接受静态内部令牌（token 模式），
  // 而商家仍必须能批准写候选，否则 prepare_* 只能等到期。
  {
    // 数据目录可能尚未创建（例如从未跑过 admin-passwd）：先建 0700，再预建库文件。
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    const oauthDbPath = path.join(options.dataDir, "oauth.sqlite");
    // 审查 P2：先以 0600 预建空文件再打开，消除「库已建、chmod 未执行」的
    // 短暂默认权限窗口。
    if (!existsSync(oauthDbPath)) {
      writeFileSync(oauthDbPath, "", { mode: 0o600 });
    }
    oauthDb = new DatabaseSync(oauthDbPath);
    chmodSync(oauthDbPath, 0o600);
    oauthStore = new MerchantOAuthStore({ db: oauthDb });
  }
  if (authMode === "oauth") {
    // issuer：public_url（生产 https）优先；loopback 开发推导为 http://127.0.0.1:<port>。
    const issuer =
      options.issuer ?? (isLoopbackHost(host) ? `http://127.0.0.1:${port}` : undefined);
    if (issuer === undefined) {
      throw new MerchantAssemblyError(
        "OAUTH_ISSUER_REQUIRED",
        "merchant_mcp.auth_mode=oauth 且监听非 loopback 地址时必须配置 merchant_mcp.public_url（https）作为 OAuth issuer",
      );
    }
    // 授权码/token/客户端注册同样落 oauth.sqlite（上面已按 0600 打开）。
    oauth = new MerchantOAuthServer({
      store: oauthStore,
      issuer,
      resource: `${issuer}${mcpPath}`,
      connectorSource: "kiwi-merchant",
      merchantName: profile.name ?? profile.owner_id,
      merchantId: profile.owner_id,
    });
    verifier = new MerchantOAuthVerifier({
      store: oauthStore,
      expectedMerchantId: profile.owner_id,
    });
  } else {
    verifier = resolveMerchantMcpVerifier(options.tokenEnv);
    // token 模式（含网关路由形态：实例只接受网关的静态内部令牌）下，写操作
    // 确认页同样挂载，商家在 /admin/pending 批准候选。
    log(
      "ℹ️ [kiwi] merchant_mcp.auth_mode=token：/mcp 使用静态内部令牌认证" +
        "（网关路由形态的推荐配置）；写操作确认页仍挂载在 /admin/*，\n" +
        "  需先 `kiwi merchant mcp admin-passwd` 设置管理员口令。\n",
    );
  }
  let authWarning: string | undefined;
  try {
    // 策略按**静态 / OAuth** 校验器判定：组合校验器恒存在，若拿它判定会让
    // 「非 loopback 且未配置任何凭据」的实例误判为已受保护而启动。
    authWarning = assertMerchantMcpAuthPolicy(host, verifier);
  } catch (err) {
    throw new MerchantAssemblyError(
      "A2A_AUTH_POLICY",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (authWarning !== undefined) log(`${authWarning}\n`);

  // 配对凭据（§8.4 第二期，最小授权）：由本实例签发、网关持有；与静态令牌
  // 并存，任一通过即放行。商家重配对即轮换，`unpair` 即吊销。
  verifier = new CompositeMerchantMcpVerifier([
    ...(verifier !== undefined ? [verifier] : []),
    new PairedCredentialVerifier(options.dataDir),
  ]);

  // 依赖装配与 chat kernel 同一套：agent data dir + state.sqlite + 审批候选 store。
  // 审批候选与对话内核共享同一 DB——MCP 生成的 draft 候选在内核侧 /pending 可见。
  const paths = ensurePathsForDir(options.dataDir);
  const db = openAgentDatabase(paths.db);
  const now = () => new Date().toISOString();
  const store = new MemoryStore({ db, vault: new PrivateVault(), now });
  const principal = store.ensurePrincipal({
    principal_id: profile.agent_id,
    owner_id: profile.owner_id,
    role: profile.role,
  });
  store.bindPrincipal(principal.principal_id);
  const approvals = new WriteApprovalCandidateStore({
    db,
    principalId: principal.principal_id,
    now,
  });
  // 执行钩子是进程级的：重启后遗留的 pending 候选无法被本进程执行。按
  // expireForRecovery 语义把非本服务可恢复的候选先失效（防虚报死候选）；
  // draft_product_change 候选的参数在库内、钩子可确定性重建，留给
  // service.recoverPendingDrafts() 恢复（阶段四审批闭环）。
  for (const candidate of approvals.listPending()) {
    if (candidate.tool !== "draft_product_change")
      approvals.expireCandidate(candidate.candidate_id);
  }

  // merchantClient：fake provider 走离线 Fake，否则真实网关（同 kernel-builder）。
  let merchantClient: MerchantClient;
  if (isFakeProvider(profile)) {
    merchantClient = new FakeMerchantClient({ products: [fakeMerchantProduct()] });
  } else {
    const broker = new ProfileCredentialBroker(profile);
    const httpClient = new HttpMerchantClient(profile.commerce.base_url, broker);
    merchantClient = httpClient;
    // 能力探测（V2 阶段一/P0-5；协议协商升级）：结果落盘供版本组合锁定。
    // verdict=incompatible（网关通告不含 Kiwi 需要的协议版本）→ 硬拒绝启动；
    // indeterminate/unhealthy（不可达/协商不可用且不可判定/健康未过）→ 警示
    // 但不阻塞（网关可能仍在启动，报价路径本身 fail-closed，不产生报价）。
    const probe = await httpClient.probeCapabilities({
      persistPath: path.join(options.dataDir, "capability-probe.json"),
    });
    if (probe.verdict === "incompatible") {
      throw new MerchantAssemblyError(
        "SHOPPING_PROTOCOL_INCOMPATIBLE",
        `shopping-cli 协议不兼容，拒绝启动：${probe.error ?? "未知原因"}。` +
          "升级或更换 shopping-cli 网关（需支持 shopping.negotiation/0.1）后重试。",
      );
    }
    if (!probe.ok) {
      log(
        `⚠️ [kiwi] shopping-cli 能力探测未通过：${probe.error ?? "未知原因"}；` +
          "相关读取/报价在上游恢复前 fail-closed。\n",
      );
    }
  }
  const intelligence =
    profile.merchant_experience?.enabled === true &&
    profile.merchant_experience.intelligence !== false
      ? new DefaultMerchantIntelligenceBackend({
          merchant_id: profile.owner_id,
          data_dir: paths.dir,
          // presentation context 的 principalId 用 owner_id（商家读取口径）——
          // backend 的 principal 校验键与之对齐（MCP 服务侧统一 owner 口径）。
          principal_id: profile.owner_id,
          merchant_client: merchantClient,
          approvals,
          now,
        })
      : undefined;
  // BUG-07：运行中策略提供器（覆盖层 <merchantDataDir>/policy-overrides.json）。
  // 本进程（MCP）为写端：校验 patch + 原子写完整生效策略；A2A 子进程为读端：
  // 按文件 mtime 读取——策略变更跨进程立即生效，不再只落盘不生效。
  const policyRuntime = new MerchantPolicyRuntime({
    basePolicy: profile.merchant_policy,
    file: path.join(options.dataDir, "policy-overrides.json"),
    now,
  });
  // 共享业务入口（V2 阶段二）：merchant-core 包装 V1 facade（facade 语义不变），
  // MCP 工具层经 core 调用；私密读取审计目录落 merchantDataDir/private-audit。
  // ---- 询报价工作台（设计 v0.1.1 §17.2：rfq_core 缺省开；rfq_release 缺省关）----
  const rfqEnabled = process.env.KIWI_RFQ_ENABLED !== "0";
  const rfqReleaseEnabled = process.env.KIWI_RFQ_RELEASE === "1";
  const rfqPriceUnitRaw = process.env.KIWI_RFQ_PRICE_UNIT;
  const rfqPriceUnit =
    rfqPriceUnitRaw === "minor" || rfqPriceUnitRaw === "yuan" ? rfqPriceUnitRaw : undefined;
  const rfqStack = (() => {
    if (!rfqEnabled) return undefined;
    ensureArtifactRoot(options.dataDir);
    const rfqRepo = new RfqRepository({ db, merchantId: profile.owner_id, now });
    const rfqArtifacts = new RfqArtifactStore({ root: options.dataDir, now });
    const rfqPolicyVersion = (): string => {
      const running = policyRuntime.current();
      return `policy-${running.version}-${running.digest.slice(0, 12)}`;
    };
    const rfqCoordinator = new RfqReleaseCoordinator({
      repo: rfqRepo,
      artifacts: rfqArtifacts,
      now,
      // 策略版本 = 运行中生效策略的 digest（变化即报价/候选失效，§7.3）；
      // 硬策略配置从运行中商家策略装配（元→分映射；映射不到的检查不启用）。
      currentPolicy: () => ({
        version: rfqPolicyVersion(),
        config: rfqPolicyConfigFromMerchantPolicy(policyRuntime.current().policy),
      }),
    });
    return {
      executors: rfqCoordinator.buildExecutors(),
      coordinator: rfqCoordinator,
      service: new MerchantRfqService({
        repo: rfqRepo,
        dataSource: new MerchantClientCommerceDataSource({
          client: merchantClient,
          merchantId: profile.owner_id,
          // 价格单位口径必须显式声明（不猜测元/分，§2.3/§21.2）。
          ...(rfqPriceUnit !== undefined ? { priceUnit: rfqPriceUnit } : {}),
        }),
        artifacts: rfqArtifacts,
        coordinator: rfqCoordinator,
        now,
        // 具名确认引用（服务端签发；模型自报确认不作数，§11.2）。
        confirmationMinter: (input) =>
          `cfm_${createHash("sha256")
            .update(
              [
                input.caseId,
                String(input.revision),
                input.lineId,
                input.sku,
                input.actor,
                now(),
              ].join("\u0000"),
            )
            .digest("hex")
            .slice(0, 24)}`,
        // 审批候选状态（恢复同步：候选已死的发布标 SUPERSEDED，§9.5）。
        candidateStatus: (candidateId: string) => approvals.get(candidateId)?.status,
        policyVersion: rfqPolicyVersion,
        // 报价有效期跟随运行中策略 TTL（§13.1：调整走部署配置/策略）。与
        // rfqPolicyConfigFromMerchantPolicy 的 max_valid_until_days 同用向下
        // 取整到天（TTL < 86400s 时两侧同为 1 天），避免「策略 TTL 短于
        // 缺省 7 天 → 计价必拒」的装配错配。
        quoteValidityDays: () => {
          const ttl = policyRuntime.current().policy?.quote_ttl_seconds;
          return ttl !== undefined && ttl > 0 ? Math.max(1, Math.floor(ttl / 86_400)) : undefined;
        },
      }),
    };
  })();
  const service = new MerchantCoreService({
    profile,
    merchantClient,
    approvals,
    // MCP 写工具一律 force_pending 只产候选，mode 不影响执行安全；固定 supervised。
    mode: () => "supervised",
    now,
    // 商家 A2A 节点 ledger 基础目录（LedgerStore 会再拼 /ledger）。
    a2aLedgerDir: path.join(paths.dir, "a2a"),
    ...(intelligence !== undefined ? { intelligence } : {}),
    auditDir: path.join(options.dataDir, "private-audit"),
    // 命令记录授权主体 = 审批 store principal（批准/拒绝主体一致性校验）。
    commandPrincipalId: principal.principal_id,
    // BUG-02：一次性确认凭证存储（OAuth 模式；execute/reject 必须携带有效凭证）。
    ...(oauthStore !== undefined ? { confirmations: oauthStore } : {}),
    // 长任务 operation store（与命令记录同一 state.sqlite，单 owner 写）。
    operations: new MerchantOperationStore({ db, now }),
    // F08 能力接线：能力探测落盘记录中 listing_pause=false 时 fail-closed「不可得」。
    ...(probeCapabilitiesListingPause(options.dataDir) !== undefined
      ? { capabilities: { listing_pause: probeCapabilitiesListingPause(options.dataDir) } }
      : {}),
    // F17/BUG-07 策略热更新：经 MerchantPolicyRuntime 校验 + 原子写完整生效
    // 策略（版本/digest 回执进命令记录）；A2A 进程按同一文件 mtime 读取生效。
    applyPolicyOverride: (patch) => policyRuntime.apply(patch),
    // 运行中策略读取：执行器硬策略（底价兜底）按当前生效策略校验。
    currentPolicy: () => policyRuntime.current().policy,
    // 询报价子服务（v0.1.1 §11.1）：未配置时 rfq 工具面 fail-closed「不可得」。
    ...(rfqStack !== undefined
      ? { rfq: { service: rfqStack.service, executors: rfqStack.executors } }
      : {}),
    extraExecutors: [
      ...createExactProductExecutors({ merchantId: profile.owner_id, client: merchantClient }),
      ...(options.extraExecutors ?? []),
    ],
    ...(options.requireCommittedProductDecisions === true
      ? { requireCommittedProductDecisions: true }
      : {}),
  });
  // 审批闭环（阶段三推广版）：恢复全部已注册写工具的 pending 命令（覆盖 V1
  // recoverPendingDrafts 语义）；未注册工具的死候选标 expired。
  const recovered = service.recoverPendingCommands();
  // RFQ 恢复同步：候选已死的发布请求标 SUPERSEDED（不冒充外部已撤销）。
  const rfqRecovered = rfqStack?.service.recoverReleases() ?? 0;
  void rfqRecovered; // 数量仅在需要排障时打日志（避免正常启动噪音）。
  // RFQ 幂等记录保留清理（§10.3：30 天；prepare/移交准备类跟随报价保留）。
  const rfqPruned = rfqStack?.service.pruneExpiredIdempotency() ?? 0;
  void rfqPruned; // 数量仅在需要排障时打日志（避免正常启动噪音）。
  // 七类 presentation → MCP 资源（V2 阶段二；私密类不进资源）。
  const presentations = buildMerchantPresentationResources({
    context: {
      profile,
      // presentation 的 enrich 以 principalId 作为商家读取口径（目录/intelligence
      // 都按 merchant_id 校验）——用 owner_id，不用进程 principal（agent_id）。
      principalId: profile.owner_id,
      merchantClient,
      approvals,
      ...(intelligence !== undefined ? { intelligence } : {}),
    },
  });
  // 配对兑换：两种认证模式都挂载——凭据由本实例在兑换时新签，不依赖环境变量。
  const serverOptions: MerchantMcpServerOptions = {
    service,
    host,
    port,
    path: mcpPath,
    pairing: {
      dir: options.dataDir,
      instance: () => ({
        ownerId: profile.owner_id,
        principalId: profile.agent_id,
      }),
    },
    ...(verifier !== undefined ? { auth: verifier } : {}),
    ...(oauth !== undefined ? { oauth } : {}),
    presentations,
    // 配套商家确认页面（BUG-01/03）：cookie 会话 + 一次性确认凭证，两种认证
    // 模式下都挂载（会话/凭证存 oauth.sqlite，与 OAuth 授权服务器同库不同表）。
    ...(oauthDb !== undefined && oauthStore !== undefined
      ? {
          admin: {
            merchantName: profile.name ?? profile.owner_id,
            surface: merchantAdminSurface(service),
            sessions: new MerchantAdminSessions({ db: oauthDb }),
            store: oauthStore,
            adminDir: options.dataDir,
            secureCookies: (options.issuer ?? "").startsWith("https://"),
            // M4 §5.4：管理入口如实展示开通状态与本地兜底视图（服务端权威，
            // 不在前端推断）。控制面可达性由本进程已知的配置决定，缺省按不可达
            // ——"不知道"不等于"正常"。
            onboarding: {
              store: new OnboardingStore(oauthDb),
              merchantId: profile.owner_id,
              controlPlaneReachable: options.catalogReachable === true,
              readiness: async () => ({ ready: true, checks: {} }),
            },
          },
        }
      : {}),
    // 询报价工具面与管理页（v0.1.1 §11.2/§11.4；rfq_core 开时挂载）。
    ...(rfqStack !== undefined
      ? {
          rfq: {
            tools: buildRfqMcpTools(
              {
                rfq: rfqStack.service,
                // 发布候选登记接缝：经 MerchantCommandLog（release_quote 风险语义）。
                prepareReleaseCandidate: async (args) => {
                  const prepared = await service.commands.prepare({
                    tool: "kiwi_merchant_prepare_quote_release",
                    arguments: { release_id: args.releaseId },
                  });
                  return prepared.candidate.candidate_id;
                },
                prepareHandoffCandidate: async (args) => {
                  const prepared = await service.commands.prepare({
                    tool: "kiwi_merchant_prepare_quote_handoff",
                    arguments: {
                      handoff_id: args.handoffId,
                      packet_json: args.packetJson,
                      packet_digest: args.packetDigest,
                    },
                  });
                  return prepared.candidate.candidate_id;
                },
                // AuthContext 服务端工厂：单商家单主体实例的调用主体固定
                // （与命令记录主体一致；不取模型参数，§11.1/§9.3）。
                callContext: () => ({
                  principalId: principal.principal_id,
                  actor: principal.principal_id,
                  traceId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                }),
              },
              { releaseEnabled: rfqReleaseEnabled },
            ),
            admin: rfqAdminSurface(service),
            // MCP Apps 展示资源（ui://kiwi-rfq/*；宿主不支持时结构化文本降级）。
            resources: buildRfqPresentationResources({
              rfq: rfqStack.service,
              callContext: () => ({
                principalId: principal.principal_id,
                actor: principal.principal_id,
                traceId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              }),
            }),
          },
        }
      : {}),
    serverInfo: { name: "kiwi-merchant", version: PRODUCT_VERSION },
  };

  return {
    serverOptions,
    service,
    recovered,
    authMode,
    authLabel: verifier?.name ?? "none（loopback-only）",
    policy: () => {
      const current = policyRuntime.current();
      return { version: current.version, digest: current.digest };
    },
    close: async () => {
      oauthDb?.close();
      db.close();
    },
  };
}
