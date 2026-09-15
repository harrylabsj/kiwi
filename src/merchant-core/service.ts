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
import { createHash } from "node:crypto";
import path from "node:path";

import type { IncomingConsultation } from "../agent/merchant/types.js";
import type { A2aNegotiationRow } from "../merchant/workbench-service.js";
import {
  MerchantWorkbenchError,
  MerchantWorkbenchService,
  type MerchantWorkbenchServiceDeps,
} from "../merchant/workbench-service.js";
import type { MerchantIntelligenceBackend } from "../agent/merchant/intelligence/backend.js";
import { MerchantCommandLog } from "./commands.js";
import { MerchantExecutorRegistry, type ExecutorContext } from "./executor.js";
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
  /** F17：策略热更新写入接缝（可选；缺省执行时「不可得」）。 */
  applyPolicyOverride?: (patch: Record<string, unknown>) => Promise<void> | void;
  /** 长任务 operation store（V2 阶段四；CSV 导入/撤回幂等与逐项回执）。 */
  operations?: MerchantOperationStore;
  /** merchantDataDir（F29 微信绑定状态读取等本地状态接缝）。 */
  merchantDataDir?: string;
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
  private readonly commandPrincipalId: string;
  private readonly operationsStore?: MerchantOperationStore;
  private readonly merchantDataDir?: string;
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
    if (deps.operations !== undefined) this.operationsStore = deps.operations;
    if (deps.merchantDataDir !== undefined) this.merchantDataDir = deps.merchantDataDir;
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
        ...(this.resolveShoppingReview !== undefined
          ? { resolveShoppingReview: this.resolveShoppingReview }
          : {}),
      };
      this.commandLogInstance = new MerchantCommandLog({
        store: this.approvalsRef,
        executors: MerchantExecutorRegistry.buildDefault(executorContext),
        executorContext,
        profile: this.profileRef,
        mode: this.modeRef,
        now: this.now,
        principalId: this.commandPrincipalId,
      });
    }
    return this.commandLogInstance;
  }

  /** prepare：商品创建（force_pending 候选，绝不直接执行）。 */
  prepareProductCreate(input: { product: unknown; reason?: string }) {
    return this.commands.prepare({
      tool: "kiwi_merchant_prepare_product_create",
      arguments: { product: input.product },
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

  /** 确认通道：批准并执行（授权主体一致性 + 重校验 + 幂等 + 回读）。 */
  executeApproved(commandId: string) {
    return this.commands.executeApproved(commandId, this.commandPrincipalId);
  }

  /** 确认通道：拒绝候选。 */
  rejectCandidate(commandId: string) {
    return this.commands.reject(commandId, this.commandPrincipalId);
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
    const key =
      input.idempotency_key ??
      `csv-${createHash("sha256").update(input.csv).digest("hex").slice(0, 16)}`;
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
    const key =
      input.idempotency_key ??
      `withdraw-${createHash("sha256").update(input.skus.join(",")).digest("hex").slice(0, 16)}`;
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
