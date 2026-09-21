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
 * Merchant Core 共享业务入口（V2 阶段二：src/merchant-core/service.ts）。
 *
 * 包装 V1 `MerchantWorkbenchService`（facade 语义不变：白名单脱敏、租户校验、
 * MerchantWorkbenchError、fail-closed），在其上补齐阶段二业务面：
 *   - 两轨磋商统一列表（negotiation-adapters：source_protocol / source_id，
 *     状态名保留各协议口径；人工处理按来源路由，A2A 人审绝不调 shopping 轨）；
 *   - 私密阈值读取（F23）：仅管理面接缝，读取写审计记录（落盘 jsonl，
 *     绝不记值本身）；不作为 MCP 工具暴露，私密数值不进任何工具结果。
 *
 * MCP 工具层（src/mcp/merchant-tools.ts）改调本服务；结构类型与
 * MerchantWorkbenchService 方法面一致，既有调用方无感。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import type { IncomingConsultation } from "../agent/merchant/types.js";
import { parseProductCreateInput } from "../agent/merchant/types.js";
import type { A2aNegotiationRow } from "../merchant/workbench-service.js";
import {
  MerchantWorkbenchError,
  MerchantWorkbenchService,
  type MerchantWorkbenchServiceDeps,
} from "../merchant/workbench-service.js";
import type { MerchantIntelligenceBackend } from "../agent/merchant/intelligence/backend.js";
import type { MerchantOAuthStore } from "../auth/merchant-oauth.js";
import { MerchantCommandLog } from "./commands.js";
import type { CommittedDecisionProof, CommittedDecisionVerifier } from "./commands.js";
import {
  MerchantExecutorRegistry,
  type CommandExecutor,
  type ExecutorContext,
} from "./executor.js";
import { BROADCAST_TOOLS } from "../merchant/feed-executors.js";
import { GRANT_TOOLS } from "../merchant/grant-executors.js";
import { PROMOTION_TOOLS } from "../merchant/promotion-executors.js";
import type { GrantAction, GrantResourceType } from "../merchant/grant-store.js";
import type { ApplyPolicyResult } from "./policy-runtime.js";
import type { MerchantPolicy } from "../config/profile.js";
import { parseProductCsv } from "./product-import.js";
import type { MerchantOperation, MerchantOperationStore } from "./operations.js";
import { credentialsPathFor, syncStatePathFor } from "../weixin/credentials.js";
import { loadCredentials, loadSyncState } from "../weixin/credentials.js";
import { WeixinError } from "../weixin/types.js";
import {
  assertReviewRoute,
  fromA2aRow,
  fromShoppingConsultation,
  type UnifiedNegotiationRow,
} from "./negotiation-adapters.js";

export interface MerchantCoreServiceDeps extends MerchantWorkbenchServiceDeps {
  /** 私密阈值读取（Vault；仅管理面接缝调用，读取写审计）。 */
  privateValues?: () => Array<{ key: string; value: string }>;
  /** 私密读取审计目录（jsonl 追加；缺省则私密读取拒绝——fail-closed 不裸读）。 */
  auditDir?: string;
  /** 命令记录的授权主体（批准/拒绝主体一致性校验；= 审批 store 的 principal）。 */
  commandPrincipalId?: string;
  /** F08 能力探测结果：listing_pause=false 时 prepare_listing_change fail-closed「不可得」。 */
  capabilities?: { listing_pause?: boolean };
  /** F14：shopping 轨人工处理接口（可选；缺省执行时「不可得」）。 */
  resolveShoppingReview?: (input: {
    conversation_id: string;
    resolution: string;
  }) => Promise<unknown>;
  /** F17：策略热更新写入接缝（可选；缺省执行时「不可得」）。BUG-07：实现
   *  须校验+原子写完整生效策略并返回版本/digest（见 MerchantPolicyRuntime）。 */
  applyPolicyOverride?:
    | ((patch: Record<string, unknown>) => Promise<ApplyPolicyResult>)
    | ((patch: Record<string, unknown>) => ApplyPolicyResult);
  /** 运行中策略读取（BUG-07）：配置后执行器硬策略按当前生效策略执行。 */
  currentPolicy?: () => MerchantPolicy | undefined;
  /** 长任务 operation store（V2 阶段四；CSV 导入/撤回幂等与逐项回执）。 */
  operations?: MerchantOperationStore;
  /** merchantDataDir（F29 微信绑定状态读取等本地状态接缝）。 */
  merchantDataDir?: string;
  /** 一次性确认凭证存储（BUG-02；配置后 execute/reject 必须携带有效凭证）。 */
  confirmations?: MerchantOAuthStore;
  /**
   * RFQ 子服务（询报价工作台设计 v0.1.1 §11.1）：配置后启用 rfq 工具面、
   * 发布/移交执行器与管理页路由；不配置时对应能力 fail-closed「不可得」。
   */
  rfq?: {
    service: import("./rfq/service.js").MerchantRfqService;
    /** RFQ 固定执行器（发布/移交；静态合并进注册表）。 */
    executors: import("./executor.js").CommandExecutor[];
  };
  /** Additional Workbench executors fixed at Runtime startup. */
  extraExecutors?: CommandExecutor[];
}

export class MerchantCoreService {
  /** V1 facade（委托转发；facade 语义不变）。 */
  readonly workbench: MerchantWorkbenchService;
  private readonly intelligence?: MerchantIntelligenceBackend;
  private readonly privateValues?: () => Array<{ key: string; value: string }>;
  private readonly auditDir?: string;
  private readonly capabilities?: { listing_pause?: boolean };
  private readonly resolveShoppingReview?: MerchantCoreServiceDeps["resolveShoppingReview"];
  private readonly applyPolicyOverride?: MerchantCoreServiceDeps["applyPolicyOverride"];
  private readonly currentPolicy?: MerchantCoreServiceDeps["currentPolicy"];
  private readonly commandPrincipalId: string;
  private readonly confirmationStore?: MerchantOAuthStore;
  private readonly operationsStore?: MerchantOperationStore;
  private readonly merchantDataDir?: string;
  private readonly rfqDeps?: MerchantCoreServiceDeps["rfq"];
  private readonly extraExecutors: CommandExecutor[];
  private readonly now: () => string;
  private readonly principalId: string;
  private readonly approvalsRef: MerchantWorkbenchServiceDeps["approvals"];
  private readonly profileRef: MerchantWorkbenchServiceDeps["profile"];
  private readonly modeRef: MerchantWorkbenchServiceDeps["mode"];

  constructor(deps: MerchantCoreServiceDeps) {
    this.workbench = new MerchantWorkbenchService(deps);
    this.now = deps.now;
    this.principalId = deps.profile.agent_id;
    this.approvalsRef = deps.approvals;
    this.profileRef = deps.profile;
    this.modeRef = deps.mode;
    this.commandPrincipalId = deps.commandPrincipalId ?? deps.profile.agent_id;
    if (deps.intelligence !== undefined) this.intelligence = deps.intelligence;
    if (deps.privateValues !== undefined) this.privateValues = deps.privateValues;
    if (deps.auditDir !== undefined) this.auditDir = deps.auditDir;
    if (deps.capabilities !== undefined) this.capabilities = deps.capabilities;
    if (deps.resolveShoppingReview !== undefined)
      this.resolveShoppingReview = deps.resolveShoppingReview;
    if (deps.applyPolicyOverride !== undefined) this.applyPolicyOverride = deps.applyPolicyOverride;
    if (deps.currentPolicy !== undefined) this.currentPolicy = deps.currentPolicy;
    if (deps.operations !== undefined) this.operationsStore = deps.operations;
    if (deps.merchantDataDir !== undefined) this.merchantDataDir = deps.merchantDataDir;
    if (deps.confirmations !== undefined) this.confirmationStore = deps.confirmations;
    if (deps.rfq !== undefined) this.rfqDeps = deps.rfq;
    this.extraExecutors = deps.extraExecutors ?? [];
  }

  /** RFQ 子服务（未配置 → undefined；工具面 fail-closed）。 */
  get rfqService(): import("./rfq/service.js").MerchantRfqService | undefined {
    return this.rfqDeps?.service;
  }

  /**
   * BD-03 管理面策略提交入口（未配置策略运行时 → undefined）。
   * 回执只含版本与摘要——策略数值本身不出现在任何回执（红线 6）。
   */
  get policyApplier():
    ((patch: Record<string, unknown>) => Promise<{ version: number; digest: string }>) | undefined {
    if (this.applyPolicyOverride === undefined) return undefined;
    const apply = this.applyPolicyOverride;
    return async (patch) => {
      const applied = await apply(patch);
      return { version: applied.version, digest: applied.digest };
    };
  }

  // ---- V1 facade 委托（MCP 工具层经此调用） --------------------------------

  listPublicProducts() {
    return this.workbench.listPublicProducts();
  }
  getPublicProduct(sku: string, merchantId?: string) {
    return this.workbench.getPublicProduct(sku, merchantId);
  }
  getInventorySnapshot(sku: string) {
    return this.workbench.getInventorySnapshot(sku);
  }
  listA2aNegotiations(limit?: unknown) {
    return this.workbench.listA2aNegotiations(limit);
  }
  listActiveConsultations() {
    return this.workbench.listActiveConsultations();
  }
  listHumanReviews() {
    return this.workbench.listHumanReviews();
  }
  getAnalytics(period?: string) {
    return this.workbench.getAnalytics(period);
  }
  draftProductChange(input: Parameters<MerchantWorkbenchService["draftProductChange"]>[0]) {
    return this.workbench.draftProductChange(input);
  }
  recoverPendingDrafts() {
    return this.workbench.recoverPendingDrafts();
  }
  approveCandidate(candidateId: string) {
    return this.workbench.approveCandidate(candidateId);
  }

  // ---- 写闭环（V2 阶段三：持久命令记录 + 固定执行器注册表） -----------------

  private commandLogInstance: MerchantCommandLog | undefined;

  /** 持久命令记录（lazy；store 即 WriteApprovalCandidateStore，单 owner 写）。 */
  get commands(): MerchantCommandLog {
    if (this.commandLogInstance === undefined) {
      const executorContext: ExecutorContext = {
        merchantClient: this.workbench.merchantClientRef,
        profile: this.profileRef,
        ownerId: this.workbench.ownerIdRef,
        ...(this.operationsStore !== undefined ? { operations: this.operationsStore } : {}),
        ...(this.applyPolicyOverride !== undefined
          ? { applyPolicyOverride: this.applyPolicyOverride }
          : {}),
        ...(this.currentPolicy !== undefined ? { currentPolicy: this.currentPolicy } : {}),
        ...(this.resolveShoppingReview !== undefined
          ? { resolveShoppingReview: this.resolveShoppingReview }
          : {}),
      };
      this.commandLogInstance = new MerchantCommandLog({
        store: this.approvalsRef,
        executors: MerchantExecutorRegistry.buildDefault(executorContext, [
          ...(this.rfqDeps?.executors ?? []),
          ...this.extraExecutors,
        ]),
        executorContext,
        profile: this.profileRef,
        mode: this.modeRef,
        now: this.now,
        principalId: this.commandPrincipalId,
        ...(this.confirmationStore !== undefined ? { confirmations: this.confirmationStore } : {}),
      });
    }
    return this.commandLogInstance;
  }

  /** prepare：商品创建（force_pending 候选，绝不直接执行）。入参白名单
   *  校验 + merchant_id 钉死归属（审查 P1：否则批准后执行必然失败或可跨
   *  商家写，白烧人工确认）。 */
  prepareProductCreate(input: { product: unknown; reason?: string }) {
    let product: unknown;
    try {
      product = parseProductCreateInput(input.product, this.workbench.ownerIdRef);
    } catch (err) {
      throw new MerchantWorkbenchError(
        "validation",
        `product 入参不合法：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.commands.prepare({
      tool: "kiwi_merchant_prepare_product_create",
      arguments: { product },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  /** prepare：库存调整。 */
  prepareInventoryUpdate(input: { sku: string; stock: number; reason?: string }) {
    if (!Number.isInteger(input.stock) || input.stock < 0) {
      throw new MerchantWorkbenchError("validation", "stock 必须是非负整数");
    }
    return this.commands.prepare({
      tool: "kiwi_merchant_prepare_inventory_update",
      arguments: { sku: input.sku, stock: input.stock },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  /** prepare：listing 销售状态变更（F08 语义；上游不支持 → fail-closed「不可得」）。 */
  async prepareListingChange(input: { sku: string; paused: boolean; reason?: string }) {
    if (this.capabilities?.listing_pause === false) {
      throw new MerchantWorkbenchError(
        "unavailable",
        "上游 shopping-cli 不支持 listing 暂停/恢复端点（能力探测 listing_pause=false）；不可得，不降级为库存写零。",
      );
    }
    return this.commands.prepare({
      tool: "kiwi_merchant_prepare_listing_change",
      arguments: { sku: input.sku, paused: input.paused },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  /** prepare：人工处理（F14 两轨；A2A 轨执行面 fail-closed「不可得」留后续）。 */
  async prepareReviewResolve(input: {
    source_protocol: "a2a" | "shopping";
    source_id: string;
    resolution: string;
    reason?: string;
  }) {
    if (input.source_protocol === "a2a") {
      throw new MerchantWorkbenchError(
        "unavailable",
        "A2A 轨人工处理的执行面尚未落地（不经 shopping-cli resolve-review）；不可得。",
      );
    }
    return this.commands.prepare({
      tool: "kiwi_merchant_prepare_review_resolve",
      arguments: { source_id: input.source_id, resolution: input.resolution },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  /** prepare：策略变更（F17 热更新；执行器写入覆盖层即生效）。 */
  preparePolicyChange(input: { patch: Record<string, unknown>; reason?: string }) {
    return this.commands.prepare({
      tool: "kiwi_merchant_prepare_policy_change",
      arguments: { patch: input.patch },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  prepareBroadcastPublish(input: {
    broadcast: Record<string, unknown>;
    authorization?: Record<string, unknown>;
    workflowId?: string;
    reason?: string;
  }) {
    return this.commands.prepare({
      tool: BROADCAST_TOOLS.publish,
      arguments: {
        broadcast_id: `bct_${randomBytes(16).toString("base64url")}`,
        input: input.broadcast,
        ...(input.authorization !== undefined ? { authorization: input.authorization } : {}),
        ...(input.workflowId !== undefined ? { workflow_id: input.workflowId } : {}),
      },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  prepareBroadcastRevise(input: {
    broadcastId: string;
    expectedRevision: number;
    broadcast: Record<string, unknown>;
    authorization?: Record<string, unknown>;
    reason?: string;
  }) {
    return this.commands.prepare({
      tool: BROADCAST_TOOLS.revise,
      arguments: {
        broadcast_id: input.broadcastId,
        expected_revision: input.expectedRevision,
        input: input.broadcast,
        ...(input.authorization !== undefined ? { authorization: input.authorization } : {}),
      },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  prepareBroadcastWithdraw(input: {
    broadcastId: string;
    expectedRevision: number;
    authorization?: Record<string, unknown>;
    reason?: string;
  }) {
    return this.commands.prepare({
      tool: BROADCAST_TOOLS.withdraw,
      arguments: {
        broadcast_id: input.broadcastId,
        expected_revision: input.expectedRevision,
        ...(input.authorization !== undefined ? { authorization: input.authorization } : {}),
      },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  prepareGrantCreate(input: {
    ownerActorId: string;
    subjectId: string;
    action: GrantAction;
    resourceType: GrantResourceType;
    resourceSelector: "merchant" | "all_products" | readonly string[];
    expiresAt: string;
    reason?: string;
  }) {
    return this.commands.prepare({
      tool: GRANT_TOOLS.create,
      arguments: {
        owner_actor_id: input.ownerActorId,
        subject_id: input.subjectId,
        grant_action: input.action,
        resource_type: input.resourceType,
        resource_selector: input.resourceSelector,
        expires_at: input.expiresAt,
      },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  prepareGrantRevoke(input: { ownerActorId: string; grantId: string; reason?: string }) {
    return this.commands.prepare({
      tool: GRANT_TOOLS.revoke,
      arguments: {
        owner_actor_id: input.ownerActorId,
        grant_id: input.grantId,
      },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  preparePromotionPublish(input: {
    promotionId: string;
    expectedRevision: number;
    workflowId?: string;
    broadcastAuthorization?: Record<string, unknown>;
    reason?: string;
  }) {
    return this.commands.prepare({
      tool: PROMOTION_TOOLS.publish,
      arguments: {
        promotion_id: input.promotionId,
        expected_revision: input.expectedRevision,
        ...(input.workflowId !== undefined ? { workflow_id: input.workflowId } : {}),
        ...(input.broadcastAuthorization !== undefined
          ? { broadcast_authorization: input.broadcastAuthorization }
          : {}),
      },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  preparePromotionWithdraw(input: {
    promotionId: string;
    expectedRevision: number;
    reason?: string;
  }) {
    return this.commands.prepare({
      tool: PROMOTION_TOOLS.withdraw,
      arguments: {
        promotion_id: input.promotionId,
        expected_revision: input.expectedRevision,
      },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  /** 确认通道：批准并执行（确认凭证 + 重校验 + 幂等 + 回读）。单商家单主体
   *  实例的便捷包装——主体恒为本实例 commandPrincipalId；跨主体校验在
   *  commands.executeApproved（管理页传入会话主体时真实生效）。 */
  executeApproved(commandId: string, confirmationToken?: string) {
    return this.commands.executeApproved(commandId, this.commandPrincipalId, confirmationToken);
  }

  /** 确认通道：拒绝候选（同上：单主体便捷包装）。 */
  rejectCandidate(commandId: string, confirmationToken?: string) {
    return this.commands.reject(commandId, this.commandPrincipalId, confirmationToken);
  }

  executeCommittedDecision(
    input: Omit<CommittedDecisionProof, "actionDigest">,
    verifier: CommittedDecisionVerifier,
  ) {
    return this.commands.executeCommittedDecision(input, verifier);
  }

  getCommand(commandId: string) {
    return this.commands.getCandidate(commandId);
  }

  /**
   * 重启恢复（阶段三推广版）：恢复全部已注册写工具的 pending 命令
   * （覆盖 V1 recoverPendingDrafts 语义并推广）；未注册工具的死候选标 expired。
   */
  recoverPendingCommands(): { recovered: number; expiredUnknown: number } {
    return this.commands.recoverPending();
  }

  listPendingCommands() {
    return this.commands.listPending();
  }

  // ---- 长任务（V2 阶段四：CSV 导入/撤回 + operation 查询） -------------------

  /** prepare：CSV 商品导入（预览逐行回执；幂等键缺省 = CSV 内容 hash）。 */
  async prepareProductsImport(input: { csv: string; idempotency_key?: string; reason?: string }) {
    if (this.operationsStore === undefined) {
      throw new MerchantWorkbenchError("unavailable", "operation store 未配置（不可得）");
    }
    // 幂等键（审查 P1）：显式 key 与参数摘要绑定——同 key 同内容仍幂等重放，
    // 同 key 不同内容不再碰撞（旧逻辑会静默返回旧 operation 并谎报成功）；
    // 空/纯空白 key 拒绝（nullish 兜底不覆盖空串）。
    const userKey = input.idempotency_key?.trim() ?? "";
    if (input.idempotency_key !== undefined && userKey === "") {
      throw new MerchantWorkbenchError(
        "validation",
        "idempotency_key 不能为空字符串（省略该参数即自动按内容摘要生成）",
      );
    }
    const digest = createHash("sha256").update(input.csv).digest("hex").slice(0, 16);
    const key = userKey !== "" ? `csv-${userKey}-${digest}` : `csv-${digest}`;
    // 预览：解析 + 新增/更新判定（逐行错误回执）
    const current = await this.workbench.merchantClientRef.listProducts(this.workbench.ownerIdRef);
    const { preview } = parseProductCsv(input.csv, new Set(current.map((p) => p.sku)));
    const prepared = await this.commands.prepare({
      tool: "kiwi_merchant_prepare_products_import",
      arguments: { csv: input.csv, idempotency_key: key },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    prepared.preview = { ...prepared.preview, import_preview: preview };
    return prepared;
  }

  /** prepare：批量撤回（listing 销售状态语义；幂等键缺省 = skus hash）。 */
  async prepareProductsWithdraw(input: {
    skus: string[];
    idempotency_key?: string;
    reason?: string;
  }) {
    if (this.operationsStore === undefined) {
      throw new MerchantWorkbenchError("unavailable", "operation store 未配置（不可得）");
    }
    // 幂等键（审查 P1）：与 CSV 导入同规则——显式 key 绑定 skus 摘要，空串拒绝。
    const userKey = input.idempotency_key?.trim() ?? "";
    if (input.idempotency_key !== undefined && userKey === "") {
      throw new MerchantWorkbenchError(
        "validation",
        "idempotency_key 不能为空字符串（省略该参数即自动按内容摘要生成）",
      );
    }
    const digest = createHash("sha256").update(input.skus.join(",")).digest("hex").slice(0, 16);
    const key = userKey !== "" ? `withdraw-${userKey}-${digest}` : `withdraw-${digest}`;
    return this.commands.prepare({
      tool: "kiwi_merchant_prepare_products_withdraw",
      arguments: { skus: input.skus, idempotency_key: key },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  /** 长任务查询（read scope）。 */
  getOperation(operationId: string): MerchantOperation {
    if (this.operationsStore === undefined) {
      throw new MerchantWorkbenchError("unavailable", "operation store 未配置（不可得）");
    }
    const op = this.operationsStore.get(operationId);
    if (op === undefined) {
      throw new MerchantWorkbenchError("not_found", `未知 operation ${operationId}`);
    }
    return op;
  }

  // ---- 微信通道状态（F29：只读；脱敏；不可得明确标注） -----------------------

  /**
   * 微信绑定状态与同步概况（只读）。脱敏：绝不返回 bot_token。
   * 最近事件列表：当前微信通道无事件存储——明确「不可得」（不编造）。
   */
  getWeixinStatus(): {
    bound: boolean;
    account?: { bot_id: string; user_id: string; saved_at: string };
    sync?: { buffered: boolean; seen_count: number };
    recent_events: string;
    note?: string;
  } {
    if (this.merchantDataDir === undefined) {
      throw new MerchantWorkbenchError("unavailable", "未配置 merchantDataDir，微信状态不可得");
    }
    const credPath = credentialsPathFor(this.merchantDataDir);
    try {
      const creds = loadCredentials(credPath);
      const sync = loadSyncState(syncStatePathFor(this.merchantDataDir));
      return {
        bound: true,
        account: {
          bot_id: creds.ilink_bot_id,
          user_id: creds.ilink_user_id,
          saved_at: creds.saved_at,
        },
        sync: { buffered: sync.get_updates_buf !== "", seen_count: sync.seen.length },
        recent_events: "不可得（微信通道无事件存储；只有同步游标与去重指纹）",
      };
    } catch (err) {
      if (err instanceof WeixinError && err.code === "not_configured") {
        return {
          bound: false,
          recent_events: "不可得（未绑定）",
          note: "未绑定微信（kiwi weixin 扫码登录后绑定）",
        };
      }
      throw new MerchantWorkbenchError(
        "unavailable",
        `微信状态读取失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---- 两轨磋商（V2 §5.2） ------------------------------------------------

  /**
   * 统一磋商列表：A2A 轨（Ledger）+ shopping 会话轨（merchantClient），每条带
   * source_protocol/source_id，状态名保留各协议口径。needs_human_review：
   * 有 intelligence 时用其权威口径，否则 A2A 轨退化相位判断。
   * 单轨不可用（如未配置 ledger）不拖垮另一轨：tracks 标注 unavailable，
   * 明确「不可得」而非静默缺半（V2 §4：缺失数据明确显示）。
   */
  async listUnifiedNegotiations(limit?: unknown): Promise<{
    total: number;
    items: UnifiedNegotiationRow[];
    tracks: { a2a: "ok" | "unavailable"; shopping: "ok" | "unavailable" };
  }> {
    const tracks = { a2a: "ok" as "ok" | "unavailable", shopping: "ok" as "ok" | "unavailable" };
    let a2aRows: A2aNegotiationRow[] = [];
    try {
      a2aRows = (await this.workbench.listA2aNegotiations(limit)).items;
    } catch (err) {
      // 仅「未配置/不可用」降级为单轨；其他错误（fail-closed）照常抛出。
      if (err instanceof MerchantWorkbenchError && err.kind === "unavailable") {
        tracks.a2a = "unavailable";
      } else {
        throw err;
      }
    }
    const a2aNeedsReview = new Map<string, boolean>();
    if (this.intelligence !== undefined && tracks.a2a === "ok") {
      const digest = await this.intelligence.getNegotiationDigest({
        merchant_id: this.workbench.ownerIdRef,
        status: "all",
        limit: 100,
      });
      for (const d of digest) a2aNeedsReview.set(d.negotiation_id, d.needs_human_review);
    }
    const rows: UnifiedNegotiationRow[] = a2aRows.map((row) =>
      fromA2aRow(
        row,
        a2aNeedsReview.get(row.negotiation_id) ?? row.phase === "AWAITING_CLARIFICATION",
      ),
    );
    // shopping 会话轨（上游故障 fail-closed：错误直接透出，不混轨填充）
    let consultations: IncomingConsultation[] = [];
    try {
      consultations = await this.workbench.merchantClientRef.listIncomingConsultations(
        this.workbench.ownerIdRef,
      );
    } catch {
      tracks.shopping = "unavailable";
    }
    for (const c of consultations) rows.push(fromShoppingConsultation(c));
    rows.sort((a, b) => (a.updated_at > b.updated_at ? -1 : a.updated_at < b.updated_at ? 1 : 0));
    return { total: rows.length, items: rows, tracks };
  }

  /** 人工处理目标列表（两轨；每条带路由标记，调用方必须按来源路由）。 */
  async listHumanReviewTargets(): Promise<UnifiedNegotiationRow[]> {
    const { items } = await this.listUnifiedNegotiations(100);
    return items.filter((r) => r.needs_human_review);
  }

  /**
   * 人工处理路由守卫（V2 §5.2）：A2A 来源走 a2a 通道，shopping 来源走
   * shopping 通道；跨轨调用 fail-closed 抛错。
   */
  assertReviewRoute(row: UnifiedNegotiationRow, channel: "a2a" | "shopping"): void {
    assertReviewRoute(row.source_protocol, channel);
  }

  // ---- 私密阈值（F23：管理面接缝 + 读取审计；绝不进工具结果） ---------------

  /**
   * 读取私密阈值（店主私密面板用；不挂 MCP 工具）。读取动作写审计记录
   * （at/principal/keys 数量——绝不记值）。未配置审计目录时拒绝（fail-closed：
   * 无审计不裸读私密值）。
   */
  readPrivateThresholds(): Array<{ key: string; value: string }> {
    if (this.privateValues === undefined) {
      return [];
    }
    if (this.auditDir === undefined) {
      throw new Error("私密阈值读取需要审计目录（auditDir）；无审计不裸读（fail-closed）");
    }
    const values = this.privateValues();
    mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
    appendFileSync(
      path.join(this.auditDir, "private-access.jsonl"),
      `${JSON.stringify({
        at: this.now(),
        principal_id: this.principalId,
        action: "read_private_thresholds",
        keys_count: values.length,
      })}\n`,
      { mode: 0o600 },
    );
    return values;
  }
}
