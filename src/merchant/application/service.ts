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
 * 共用商家应用服务（BD 设计 §8.1；接口草案见 §8.2）。
 *
 * **它不是新的磋商引擎**：只编排认证上下文、既有领域操作、事务/幂等、审计与输出投影。
 * A2A handler 继续实现原协议，但与管理入口访问**同一套**商品、策略、审批与权威状态。
 *
 * 三层边界（BD §8.1 的表，逐条对上）：
 *
 *   Web UI / 工具客户端  → 只发请求、看结果；不碰权威存储，不持有服务密钥
 *   HTTP / MCP 适配层    → 路由、认证、Schema 校验、错误映射；**不重写报价/审批规则**
 *   MerchantApplicationService（本模块） → 权限与对象归属复核、用例编排、幂等事务
 *   既有 Merchant Core   → 策略、候选、任务、Ledger、真实数据；**不因内部调用绕过规则**
 *
 * 每个公开方法的第一件事都是 `assertVerifiedActor(ctx)` + 权限复核 + 归属复核：
 * 类型检查通过不算授权（BD §8.2 末句）。
 */

import {
  assertVerifiedActor,
  hasPermission,
  type MerchantPermission,
  type VerifiedActorContext,
} from "./actor.js";
import type { WriteApprovalCandidate } from "../../agent/merchant/action-candidate.js";

/** 管理与对话工具的契约大版本（BD §11.1；与 Kiwi / 协议版本分开）。 */
export const MANAGEMENT_API_MAJOR = 1;

export const SERVICE_STATES = ["OPERATING", "PAUSED", "WITHDRAWN", "DEGRADED"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/** BD §11.1 RuntimeStatus：不含秘密。 */
export interface RuntimeStatus {
  api_version: string;
  runtime_version: string;
  generation: number;
  service_state: ServiceState;
  readiness: { ready: boolean; failed_checks: string[] };
  capabilities: { management_page: boolean; dialog_tools: boolean };
  observed_at: string;
}

/** BD §11.1 ApprovalPreview：**不能泄露受限值**。 */
export interface ApprovalPreview {
  candidate_id: string;
  status: string;
  expires_at: string;
  /** 可显示摘要（脱敏）。 */
  summary: string;
  arguments_hash: string;
  preconditions_hash: string;
  related_revision: number;
}

export interface ApprovalPage {
  items: ApprovalPreview[];
  next_cursor: string | null;
}

/** BD §13.2 的最小公开商品投影（成本/底价在私有策略区，绝不经此通道）。 */
export interface MerchantProductProjection {
  sku: string;
  title: string | null;
  currency: string;
  /** 价格（major units，与 MerchantProductSource 的既有单位契约一致）。 */
  price: number;
  price_unit: string | null;
  min_order_qty: number | null;
  valid_until: string | null;
  updated_at: string | null;
  status: string;
}

export interface MerchantProductPage {
  items: MerchantProductProjection[];
  next_cursor: string | null;
}

/** BD §11.1 OperationReceipt。`unknown` 必须保留查询/对账路径。 */
export const OPERATION_STATUSES = ["accepted", "running", "succeeded", "failed", "unknown"] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export interface OperationReceipt {
  operation_id: string;
  command_type: string;
  status: OperationStatus;
  resource_ref: string | null;
  result_revision: number | null;
  created_at: string;
  completed_at: string | null;
  support_id: string;
}

export interface ApprovalDecision {
  expected_revision: number;
  arguments_hash: string;
  preconditions_hash: string;
  confirmation_ref: string;
}

/** BD §11.3 的错误码（管理面 HTTP 映射由适配层负责）。 */
export const MANAGEMENT_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "precondition_changed",
  "invalid_input",
  "rate_limited",
  "unavailable",
  "tool_binding_unavailable",
  "update_required",
] as const;
export type ManagementErrorCode = (typeof MANAGEMENT_ERROR_CODES)[number];

/** HTTP 状态映射（BD §11.3；A2A/MCP 各自保持自己的协议格式，不套用本表）。 */
export const MANAGEMENT_ERROR_STATUS: Readonly<Record<ManagementErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_changed: 409,
  invalid_input: 400,
  rate_limited: 429,
  unavailable: 503,
  tool_binding_unavailable: 503,
  update_required: 409,
};

export class ManagementError extends Error {
  readonly code: ManagementErrorCode;
  readonly supportId: string;
  readonly retryable: boolean;
  constructor(
    code: ManagementErrorCode,
    message: string,
    options: { supportId?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "ManagementError";
    this.code = code;
    this.supportId = options.supportId ?? `sup_${code}`;
    this.retryable = options.retryable ?? (code === "rate_limited" || code === "unavailable");
  }
}

/** 服务依赖：全部来自既有实现（不在这里另建业务状态）。 */
export interface MerchantApplicationDeps {
  /** 本实例身份（商家 id 由**服务端绑定**确定，不来自请求）。 */
  merchantId: string;
  generation: () => number;
  runtimeVersion: string;
  /** 就绪报告（readiness 语义；失败项只回**名字**，不回细节）。 */
  readiness: () => Promise<{ ready: boolean; checks: Record<string, { ok: boolean }> }>;
  /** 服务状态（M4 的闸门用的是同一份状态）。 */
  serviceState: () => ServiceState;
  /** 已启用能力（管理页必选；对话工具取决于 B07）。 */
  capabilities: () => { management_page: boolean; dialog_tools: boolean };
  /**
   * 待审批候选（**按商家过滤**）。
   *
   * 投影前的候选来自既有 `WriteApprovalCandidateStore`——注意它明确不存底价/成本等
   * 受限值（§7.4），因此这里的投影只需去掉不面向页面的字段。
   */
  listCandidates: () => WriteApprovalCandidate[];
  /** 取单个候选（返回 undefined 表示不存在**或**不属本商家——上层统一 404）。 */
  getCandidate: (candidateId: string) => WriteApprovalCandidate | undefined;
  /**
   * 消费确认引用并执行/拒绝候选（既有 core 的命令日志负责执行语义）。
   *
   * 这里**不重新实现**审批规则：只做归属/权限/幂等/确认引用编排。
   */
  decide: (input: {
    candidateId: string;
    actorId: string;
    merchantId: string;
    approve: boolean;
    confirmationRef: string;
    reason?: string;
    idempotencyKey: string;
  }) => Promise<{ operationId: string; status: OperationStatus; resultRevision?: number }>;
  /** 操作回执查询（超时/重启后对账用）。 */
  getOperation: (operationId: string) => OperationReceipt | undefined;
  /**
   * 当前规则版本与摘要（**脱敏**：策略内容不经理由此通道；§7.2 敏感视图需
   * 独立权限）。缺省或摘要为空 → unavailable，不伪造规则。
   */
  policy?: () => { version: number; digest: string } | undefined;
  /**
   * 公开商品分页投影（真实商品源接入属 BD-03；缺省 → unavailable，
   * **不伪造空目录**——空目录会让「源失联」看起来像「无商品」）。
   */
  products?: (query: PageQuery) => Promise<MerchantProductPage>;
  now?: () => Date;
}

const APPROVAL_PAGE_DEFAULT_LIMIT = 20;
const APPROVAL_PAGE_MAX_LIMIT = 100;

export interface PageQuery {
  cursor?: string;
  limit?: number;
}

export class MerchantApplicationService {
  private readonly deps: MerchantApplicationDeps;
  private readonly now: () => Date;

  constructor(deps: MerchantApplicationDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  // ── 只读 ────────────────────────────────────────────────────────────

  /** GET /merchant/api/status */
  async getStatus(ctx: VerifiedActorContext): Promise<RuntimeStatus> {
    this.authorize(ctx, "status:read");
    const readiness = await this.deps.readiness();
    return {
      api_version: `${MANAGEMENT_API_MAJOR}`,
      runtime_version: this.deps.runtimeVersion,
      generation: this.deps.generation(),
      service_state: this.deps.serviceState(),
      readiness: {
        ready: readiness.ready,
        failed_checks: Object.entries(readiness.checks)
          .filter(([, check]) => !check.ok)
          .map(([name]) => name),
      },
      capabilities: this.deps.capabilities(),
      observed_at: this.now().toISOString(),
    };
  }

  /** GET /merchant/api/approvals —— 按商家过滤 + 脱敏投影。 */
  async listApprovals(ctx: VerifiedActorContext, query: PageQuery = {}): Promise<ApprovalPage> {
    this.authorize(ctx, "approvals:read");
    const limit = clampLimit(query.limit);
    // 归属过滤在**服务层**做：适配层拿到的列表不得自行裁剪（BD §8.1）。
    const candidates = this.deps
      .listCandidates()
      .filter((candidate) => this.belongsToMerchant(candidate));
    const start = decodeCursor(query.cursor);
    const page = candidates.slice(start, start + limit);
    const next = start + limit < candidates.length ? String(start + limit) : null;
    return { items: page.map((candidate) => this.toPreview(candidate)), next_cursor: next };
  }

  /** GET /merchant/api/approvals/{id} —— 跨商家**统一 404**（§9.2 防枚举）。 */
  async getApproval(ctx: VerifiedActorContext, candidateId: string): Promise<ApprovalPreview> {
    this.authorize(ctx, "approvals:read");
    const candidate = this.requireOwnedCandidate(candidateId);
    return this.toPreview(candidate);
  }

  /** GET /merchant/api/operations/{id} —— 超时/重启后确认结果。 */
  getOperation(ctx: VerifiedActorContext, operationId: string): OperationReceipt {
    this.authorize(ctx, "operations:read");
    const receipt = this.deps.getOperation(operationId);
    if (receipt === undefined) {
      throw new ManagementError("not_found", `unknown operation: ${operationId}`);
    }
    return receipt;
  }

  /** GET /merchant/api/policy —— 规则版本与摘要（脱敏；内容不在此通道）。 */
  async getPolicy(ctx: VerifiedActorContext): Promise<{ policy_revision: number; digest: string }> {
    this.authorize(ctx, "policy:read");
    const current = this.deps.policy?.();
    if (current === undefined || current.digest === "") {
      throw new ManagementError("unavailable", "policy projection is not available");
    }
    return { policy_revision: current.version, digest: current.digest };
  }

  /** GET /merchant/api/products —— 公开商品投影分页；无商品源时 503，不伪造空目录。 */
  async listProducts(
    ctx: VerifiedActorContext,
    query: PageQuery = {},
  ): Promise<MerchantProductPage> {
    this.authorize(ctx, "products:read");
    const source = this.deps.products;
    if (source === undefined) {
      throw new ManagementError(
        "unavailable",
        "product source does not expose a management listing yet",
      );
    }
    return source(query);
  }

  // ── 写：确认链与审批 ────────────────────────────────────────────────

  /**
   * POST /merchant/api/approvals/{id}/approve|reject —— 执行前**重新校验前置条件**。
   *
   * BD §10.3：不能只检查"之前批准过"。确认引用单次消费、候选状态更新与领域提交
   * 应为原子操作；前置条件变化 → `precondition_changed`(409)，旧确认不能继续使用。
   */
  async decideApproval(
    ctx: VerifiedActorContext,
    candidateId: string,
    decision: ApprovalDecision,
    options: { approve: boolean; reason?: string; idempotencyKey: string },
  ): Promise<OperationReceipt> {
    this.authorize(ctx, "approvals:decide");
    const candidate = this.requireOwnedCandidate(candidateId);

    // 版本与摘要复核：页面确认的是**具体版本**，不是"这个候选"这个概念。
    if (candidate.arguments_hash !== decision.arguments_hash) {
      throw new ManagementError("precondition_changed", "candidate arguments changed since preview");
    }
    if (candidate.preconditions_hash !== decision.preconditions_hash) {
      throw new ManagementError("precondition_changed", "candidate preconditions changed since preview");
    }
    // 既有候选状态机的词汇是 pending_approval（不是 "pending"）——直接复用它的
    // 取值，不另造一套平行状态（BD §8.1：适配层与服务层都不重建业务状态机）。
    if (candidate.status !== "pending_approval") {
      throw new ManagementError(
        "conflict",
        `candidate is not awaiting approval (status: ${candidate.status})`,
      );
    }
    if (Date.parse(candidate.expires_at) <= this.now().getTime()) {
      throw new ManagementError("precondition_changed", "candidate has expired");
    }
    if (String(decision.confirmation_ref ?? "").trim() === "") {
      // 不接受"没有确认引用但有 approved=true"这类形状（§7.3）。
      throw new ManagementError("forbidden", "confirmation reference is required for write operations");
    }

    const result = await this.deps.decide({
      candidateId,
      actorId: ctx.actorId,
      merchantId: ctx.merchantId,
      approve: options.approve,
      confirmationRef: decision.confirmation_ref,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      idempotencyKey: options.idempotencyKey,
    });

    const stamp = this.now().toISOString();
    return {
      operation_id: result.operationId,
      command_type: options.approve ? "approval.approve" : "approval.reject",
      status: result.status,
      resource_ref: candidateId,
      result_revision: result.resultRevision ?? null,
      created_at: stamp,
      completed_at: isTerminal(result.status) ? stamp : null,
      support_id: `sup_${result.operationId.slice(-8)}`,
    };
  }

  // ── 内部：授权与归属 ────────────────────────────────────────────────

  /**
   * 运行时授权（BD §8.2：类型检查通过也必须在运行时再查一次）。
   *
   * 这里的 `ctx.merchantId` 必须等于**本实例的商家**：同一个服务实例只服务一个商家，
   * 任何"用别的商家主体调进来"的请求都是越权（UC09/UC10）。
   */
  private authorize(
    ctx: VerifiedActorContext,
    permission: MerchantPermission,
  ): VerifiedActorContext {
    const actor = assertVerifiedActor(ctx, this.now());
    if (!hasPermission(actor, permission)) {
      throw new ManagementError("forbidden", `missing permission: ${permission}`);
    }
    if (actor.merchantId !== this.deps.merchantId) {
      // 会话属于别的商家：一律按"不属于本商家"处理，不透露对方是否存在。
      throw new ManagementError("not_found", "resource does not belong to this merchant");
    }
    return actor;
  }

  private belongsToMerchant(candidate: WriteApprovalCandidate): boolean {
    // 候选目前以 principal_id 记录操作者；商家归属由本实例身份决定（单商家实例）。
    // 显式写出这一层，是为了将来引入多商家主体时**必须先改这里**，而不是靠隐式假设。
    return (
      candidate.principal_id.startsWith("merchant-agent:") ||
      candidate.principal_id.length > 0
    );
  }

  private requireOwnedCandidate(candidateId: string): WriteApprovalCandidate {
    const candidate = this.deps.getCandidate(String(candidateId ?? "").trim());
    if (candidate === undefined || !this.belongsToMerchant(candidate)) {
      throw new ManagementError("not_found", `unknown candidate: ${candidateId}`);
    }
    return candidate;
  }

  /** 脱敏投影：只给出可显示摘要与摘要哈希，**不含参数原文**（§11.1）。 */
  private toPreview(candidate: WriteApprovalCandidate): ApprovalPreview {
    return {
      candidate_id: candidate.candidate_id,
      status: candidate.status,
      expires_at: candidate.expires_at,
      summary: `${candidate.tool}（${candidate.risk}）`,
      arguments_hash: candidate.arguments_hash,
      preconditions_hash: candidate.preconditions_hash,
      related_revision: 1,
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return APPROVAL_PAGE_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), APPROVAL_PAGE_MAX_LIMIT);
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  const offset = Number.parseInt(cursor, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    throw new ManagementError("invalid_input", "invalid cursor");
  }
  return offset;
}

function isTerminal(status: OperationStatus): boolean {
  return status === "succeeded" || status === "failed";
}
