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
 * Merchant Workbench 的 7 个 MVP MCP 工具定义（WorkBuddy Buddy 应用开发计划
 * 阶段二）。全部 handler 委托 MerchantWorkbenchService（阶段一 Facade）——
 * 本层只做协议适配：稳定 name/description/inputSchema（JSON Schema，
 * additionalProperties: false）、structuredContent 返回、统一错误映射
 * （MerchantWorkbenchError → isError 带内返回，中文标签与 agent 工具层
 * errorText 一致）、响应体大小保护（超长截断并注明）与单次调用 30s 超时。
 *
 * 写类工具（kiwi_merchant_prepare_product_change）只返回审批候选元数据，绝不直接执行。
 */

import type {
  DraftProductChangeResult,
  MerchantWorkbenchSurface,
} from "../merchant/workbench-service.js";
import { MerchantWorkbenchError } from "../merchant/workbench-service.js";

/** 单次工具调用的响应体大小上限（字符；对齐 agent 侧 experienceMaxChars 缺省）。 */
export const MERCHANT_MCP_MAX_RESPONSE_CHARS = 12_000;

/** 单次工具调用的处理超时（WorkBuddy 连接器 30s 上限）。 */
export const MERCHANT_MCP_REQUEST_TIMEOUT_MS = 30_000;

export interface MerchantMcpToolDefinition {
  name: string;
  description: string;
  /** 原始 JSON Schema（不做 zod 依赖；additionalProperties: false）。 */
  inputSchema: Record<string, unknown>;
}

export interface MerchantMcpCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}

export interface MerchantMcpToolsOptions {
  maxChars?: number;
  requestTimeoutMs?: number;
}

/** MerchantWorkbenchError kind → 中文标签（与 agent 工具层 errorText 一致）。 */
const KIND_LABEL: Record<MerchantWorkbenchError["kind"], string> = {
  auth: "凭据被拒或缺失",
  not_found: "未找到",
  validation: "参数或服务校验失败",
  unavailable: "暂时性错误",
};

function errorResult(err: unknown): MerchantMcpCallResult {
  if (err instanceof MerchantWorkbenchError) {
    return {
      content: [{ type: "text", text: `商家操作失败（${KIND_LABEL[err.kind]}）：${err.message}` }],
      isError: true,
    };
  }
  // 审查 P2：非业务异常（底层实现错误）不透出内部细节（文件路径/网关 URL
  // 等）——对客户端收敛为统一文案，完整错误进服务端 stderr 日志。
  process.stderr.write(
    `[merchant mcp] 工具调用底层异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  return {
    content: [
      {
        type: "text",
        text: "商家操作失败（暂时性错误）：请稍后重试；若持续失败请查看服务端日志。",
      },
    ],
    isError: true,
  };
}

/** 响应体大小保护：超长截断并注明（fenceModelPayload maxChars 同思路）。 */
function okResult(payload: Record<string, unknown>, maxChars: number): MerchantMcpCallResult {
  const text = JSON.stringify(payload);
  if (text.length <= maxChars) {
    return { content: [{ type: "text", text }], structuredContent: payload };
  }
  return {
    content: [
      {
        type: "text",
        text:
          `${text.slice(0, Math.max(1, maxChars - 1))}…` +
          `（响应过大已截断：共 ${text.length} 字符，上限 ${maxChars}；请缩小查询范围，例如降低 limit）`,
      },
    ],
    structuredContent: { truncated: true, total_chars: text.length },
  };
}

/** 单次调用超时保护：超时即拒绝，绝不悬挂连接。 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              // 审查 P2：超时不取消底层工作——prepare 可能仍已落库成功，
              // 提示先查待批准列表，避免重试生成重复候选。
              new MerchantWorkbenchError(
                "unavailable",
                `请求超时（${Math.round(timeoutMs / 1000)}s 上限）；底层操作可能仍在完成——` +
                  "写操作请先用只读工具查询待批准候选，确认未生成后再重试",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 命令写面（V2 阶段三；merchant-core 提供，facade 不具备——缺失时对应工具报「不可得」）。 */
export type MerchantCommandSurface = {
  prepareProductCreate(input: {
    product: unknown;
    reason?: string;
  }): Promise<import("../merchant-core/commands.js").PreparedCommand>;
  prepareInventoryUpdate(input: {
    sku: string;
    stock: number;
    reason?: string;
  }): Promise<import("../merchant-core/commands.js").PreparedCommand>;
  prepareListingChange(input: {
    sku: string;
    paused: boolean;
    reason?: string;
  }): Promise<import("../merchant-core/commands.js").PreparedCommand>;
  prepareReviewResolve(input: {
    source_protocol: "a2a" | "shopping";
    source_id: string;
    resolution: string;
    reason?: string;
  }): Promise<import("../merchant-core/commands.js").PreparedCommand>;
  preparePolicyChange(input: {
    patch: Record<string, unknown>;
    reason?: string;
  }): Promise<import("../merchant-core/commands.js").PreparedCommand>;
  executeApproved(commandId: string): Promise<unknown>;
  rejectCandidate(commandId: string): Promise<unknown>;
  prepareProductsImport(input: {
    csv: string;
    idempotency_key?: string;
    reason?: string;
  }): Promise<import("../merchant-core/commands.js").PreparedCommand>;
  prepareProductsWithdraw(input: {
    skus: string[];
    idempotency_key?: string;
    reason?: string;
  }): Promise<import("../merchant-core/commands.js").PreparedCommand>;
  getOperation(
    operationId: string,
  ):
    | Promise<import("../merchant-core/operations.js").MerchantOperation>
    | import("../merchant-core/operations.js").MerchantOperation;
};

/** draft_product_change 的候选元数据投影（只含公开字段，绝不回传执行结果）。 */
function draftResultPayload(result: DraftProductChangeResult): Record<string, unknown> {
  const candidate = "candidate" in result.outcome ? result.outcome.candidate : undefined;
  return {
    kind: result.outcome.kind,
    ...(candidate !== undefined
      ? {
          candidate_id: candidate.candidate_id,
          tool: candidate.tool,
          status: candidate.status,
          risk: candidate.risk,
          expires_at: candidate.expires_at,
          created_at: candidate.created_at,
        }
      : {}),
    product: result.product,
  };
}

/** 撤回 SKU 列表校验（审查 P2：此前 .map(String) 把非字符串元素静默变成
 *  "[object Object]"，登记无效命令白烧人工确认）。 */
function parseSkuList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string" || s.trim() === "")) {
    throw new MerchantWorkbenchError("validation", "skus 必须是非空字符串数组");
  }
  return value;
}

/** 命令写面守卫：facade-only 调用方缺命令面时 fail-closed 报「不可得」。 */
function commandSurface(service: MerchantWorkbenchSurface): MerchantCommandSurface {
  const s = service as Partial<MerchantCommandSurface>;
  if (typeof s.prepareProductCreate !== "function") {
    throw new MerchantWorkbenchError("unavailable", "命令写面不可用（需要 merchant-core 服务）");
  }
  return s as MerchantCommandSurface;
}

/** prepare 结果投影：候选元数据 + 预览（prepare 不执行）。 */
function preparedPayload(prepared: {
  candidate: {
    candidate_id: string;
    tool: string;
    status: string;
    risk: string;
    expires_at: string;
    created_at: string;
  };
  preview: Record<string, unknown>;
}): Record<string, unknown> {
  const c = prepared.candidate;
  return {
    kind: "pending_approval",
    command_id: c.candidate_id,
    tool: c.tool,
    status: c.status,
    risk: c.risk,
    expires_at: c.expires_at,
    created_at: c.created_at,
    preview: prepared.preview,
  };
}

/** 写类工具（scope 过滤：要求 merchant:write；其余只读工具要求 merchant:read）。 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "kiwi_merchant_prepare_product_change",
  "kiwi_merchant_prepare_product_create",
  "kiwi_merchant_prepare_inventory_update",
  "kiwi_merchant_prepare_listing_change",
  "kiwi_merchant_prepare_review_resolve",
  "kiwi_merchant_prepare_policy_change",
  "kiwi_merchant_prepare_products_import",
  "kiwi_merchant_prepare_products_withdraw",
]);

/** 工具所需最小 scope。 */
export function requiredScopeForTool(name: string): "merchant:read" | "merchant:write" {
  return WRITE_TOOLS.has(name) ? "merchant:write" : "merchant:read";
}

/** scope 判定：scopes === undefined 表示静态 token 过渡模式（全量放行）。 */
function scopeAllows(scopes: string[] | undefined, required: string): boolean {
  if (scopes === undefined) return true;
  return scopes.includes(required);
}

/**
 * 构建 7 个 MVP 工具的定义与分发器。`call(name, args, scopes)` 返回 MCP
 * CallToolResult 形状；业务错误与未知工具名一律带内 isError 返回（中文说明）。
 *
 * scope 过滤（V2 阶段一）：scopes 来自 OAuth access_token 授权上下文；
 * undefined = 静态 token 过渡模式（全量）。`listTools(scopes)` 只列出已授权
 * 工具；`call` 逐次强制校验（服务端不依赖 tools/list 的展示过滤）。
 */
export function buildMerchantMcpTools(
  service: MerchantWorkbenchSurface,
  options: MerchantMcpToolsOptions = {},
): {
  tools: MerchantMcpToolDefinition[];
  listTools: (scopes?: string[]) => MerchantMcpToolDefinition[];
  call: (
    name: string,
    args: Record<string, unknown>,
    scopes?: string[],
  ) => Promise<MerchantMcpCallResult>;
} {
  const maxChars = options.maxChars ?? MERCHANT_MCP_MAX_RESPONSE_CHARS;
  const timeoutMs = options.requestTimeoutMs ?? MERCHANT_MCP_REQUEST_TIMEOUT_MS;

  const handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  > = {
    kiwi_merchant_list_products: async () => {
      const { items, source } = await service.listPublicProducts();
      return { count: items.length, source, items };
    },
    kiwi_merchant_get_product: async (args) => {
      const product = await service.getPublicProduct(
        typeof args.sku === "string" ? args.sku : "",
        typeof args.merchant_id === "string" ? args.merchant_id : undefined,
      );
      return { product };
    },
    kiwi_merchant_get_inventory: async (args) => {
      const snapshot = await service.getInventorySnapshot(
        typeof args.sku === "string" ? args.sku : "",
      );
      return { snapshot };
    },
    kiwi_merchant_list_a2a_negotiations: async (args) => {
      const { total, items } = await service.listA2aNegotiations(args.limit);
      return { total, count: items.length, items };
    },
    kiwi_merchant_list_human_reviews: async () => {
      const items = await service.listHumanReviews();
      return { count: items.length, items };
    },
    kiwi_merchant_get_analytics: async (args) => {
      const snapshot = await service.getAnalytics(
        typeof args.period === "string" ? args.period : undefined,
      );
      return { snapshot };
    },
    kiwi_merchant_prepare_product_change: async (args) => {
      const result = await service.draftProductChange({
        sku: typeof args.sku === "string" ? args.sku : "",
        changes: args.changes,
        ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        ...(typeof args.merchant_id === "string" ? { merchant_id: args.merchant_id } : {}),
      });
      return draftResultPayload(result);
    },
    // ---- V2 阶段三写闭环工具（命令记录 + 执行器；全部 merchant:write scope）----
    kiwi_merchant_prepare_product_create: async (args) =>
      commandSurface(service)
        .prepareProductCreate({
          product: args.product,
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        })
        .then(preparedPayload),
    kiwi_merchant_prepare_inventory_update: async (args) => {
      // 审查 P2：类型不符直接 validation（此前哨兵 -1 静默登记无效命令）。
      if (typeof args.stock !== "number") {
        throw new MerchantWorkbenchError("validation", "stock 必须是数字（非负整数）");
      }
      if (typeof args.sku !== "string" || args.sku.trim() === "") {
        throw new MerchantWorkbenchError("validation", "sku 必须是非空字符串");
      }
      return commandSurface(service)
        .prepareInventoryUpdate({
          sku: args.sku,
          stock: args.stock,
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        })
        .then(preparedPayload);
    },
    kiwi_merchant_prepare_listing_change: async (args) => {
      // 审查 P2：paused 非布尔直接拒绝——`"true" === true` 为 false 会把
      // 「下架」请求静默变成「恢复销售」，反转操作者意图。
      if (typeof args.paused !== "boolean") {
        throw new MerchantWorkbenchError(
          "validation",
          "paused 必须是布尔值（true=暂停销售，false=恢复销售）",
        );
      }
      if (typeof args.sku !== "string" || args.sku.trim() === "") {
        throw new MerchantWorkbenchError("validation", "sku 必须是非空字符串");
      }
      return commandSurface(service)
        .prepareListingChange({
          sku: args.sku,
          paused: args.paused,
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        })
        .then(preparedPayload);
    },
    kiwi_merchant_prepare_review_resolve: async (args) => {
      // 审查 P2：非法枚举直接拒绝——此前非 "a2a" 一律静默落到 shopping
      // 可执行轨道（含 "A2A"/拼写错误），违背「绝不跨轨」语义。
      if (args.source_protocol !== "a2a" && args.source_protocol !== "shopping") {
        throw new MerchantWorkbenchError(
          "validation",
          'source_protocol 必须是 "a2a" 或 "shopping"',
        );
      }
      if (typeof args.source_id !== "string" || args.source_id.trim() === "") {
        throw new MerchantWorkbenchError("validation", "source_id 必须是非空字符串");
      }
      if (typeof args.resolution !== "string" || args.resolution.trim() === "") {
        throw new MerchantWorkbenchError("validation", "resolution 必须是非空字符串");
      }
      return commandSurface(service)
        .prepareReviewResolve({
          source_protocol: args.source_protocol,
          source_id: args.source_id,
          resolution: args.resolution,
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        })
        .then(preparedPayload);
    },
    kiwi_merchant_prepare_policy_change: async (args) =>
      commandSurface(service)
        .preparePolicyChange({
          patch: (args.patch ?? {}) as Record<string, unknown>,
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        })
        .then(preparedPayload),
    // BUG-02：批准/拒绝已从 MCP 工具注册表移除（模型不可见不可调）——
    // 确认只经管理页面（cookie 会话 + 一次性确认凭证）。
    // ---- V2 阶段四：CSV 导入/撤回（长任务 + 幂等）与 operation 查询 ----
    kiwi_merchant_prepare_products_import: async (args) =>
      commandSurface(service)
        .prepareProductsImport({
          csv: typeof args.csv === "string" ? args.csv : "",
          ...(typeof args.idempotency_key === "string"
            ? { idempotency_key: args.idempotency_key }
            : {}),
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        })
        .then(preparedPayload),
    kiwi_merchant_prepare_products_withdraw: async (args) =>
      commandSurface(service)
        .prepareProductsWithdraw({
          skus: parseSkuList(args.skus),
          ...(typeof args.idempotency_key === "string"
            ? { idempotency_key: args.idempotency_key }
            : {}),
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        })
        .then(preparedPayload),
    kiwi_merchant_get_operation: async (args) => {
      const op = await commandSurface(service).getOperation(
        typeof args.operation_id === "string" ? args.operation_id : "",
      );
      return { operation: op as unknown as Record<string, unknown> };
    },
  };

  const skuParam = { type: "string", description: "商品 SKU" } as const;
  const merchantIdParam = {
    type: "string",
    description: "租户校验（可选）：提供时必须等于本商家 merchant_id",
  } as const;

  const tools: MerchantMcpToolDefinition[] = [
    {
      name: "kiwi_merchant_list_products",
      description: "列出商家自己的目录商品（只读；公开字段白名单，无私有底价/成本）。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "kiwi_merchant_get_product",
      description: "按 SKU 读取商家目录中的一个商品（只读，公开字段白名单）。",
      inputSchema: {
        type: "object",
        properties: { sku: skuParam, merchant_id: merchantIdParam },
        required: ["sku"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_get_inventory",
      description: "读取一个商品的当前库存快照（含观察时间，不是永恒事实）。",
      inputSchema: {
        type: "object",
        properties: { sku: skuParam },
        required: ["sku"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_list_a2a_negotiations",
      description:
        "列出商家节点的 A2A 磋商记录（结构化行：negotiation_id、相位、SKU、数量、报价、是否达成协议、时间）。",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "最多返回最近 N 笔（缺省 20，clamp 1..100）",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_list_human_reviews",
      description: "查看商家需要人工处理的队列（升级、超预算/超底价、转人工的磋商）。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "kiwi_merchant_get_analytics",
      description:
        "读取当前商家经营摘要（只读；指标由服务端计算。未配置指标后端时返回明确错误，不给演示数据）。",
      inputSchema: {
        type: "object",
        properties: {
          period: {
            type: "string",
            pattern: "^(?:[1-9]|[1-8][0-9]|90)d$",
            description: "UTC 统计窗口，1d 到 90d，例如 7d、14d、30d",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_prepare_product_change",
      description:
        "为一个商品变更生成审批候选（不立即执行，任何模式都不自动执行）。操作者批准后才会真正写入；只返回候选元数据。",
      inputSchema: {
        type: "object",
        properties: {
          sku: skuParam,
          changes: {
            type: "object",
            description: "计划修改的字段（title/price/stock/description 等）",
          },
          reason: { type: "string", description: "变更原因（可选）" },
          merchant_id: merchantIdParam,
        },
        required: ["sku", "changes"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_prepare_product_create",
      description:
        "登记商品创建命令（prepare：只产持久命令候选与预览，不执行）。经确认通道批准后才由执行器写入。",
      inputSchema: {
        type: "object",
        properties: {
          product: {
            type: "object",
            description: "sku/title/price/stock 必填；currency/category/tags/description 可选",
          },
          reason: { type: "string", description: "变更原因（可选）" },
        },
        required: ["product"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_prepare_inventory_update",
      description: "登记库存调整命令（prepare：只产候选与预览，不执行）。stock 必须是非负整数。",
      inputSchema: {
        type: "object",
        properties: {
          sku: skuParam,
          stock: { type: "integer", minimum: 0, description: "新的库存数量（>= 0）" },
          reason: { type: "string", description: "变更原因（可选）" },
        },
        required: ["sku", "stock"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_prepare_listing_change",
      description:
        "登记商品销售状态变更（F08：暂停/恢复销售）。上游不支持时返回明确「不可得」，不降级为库存写零。",
      inputSchema: {
        type: "object",
        properties: {
          sku: skuParam,
          paused: { type: "boolean", description: "true 暂停销售，false 恢复销售" },
          reason: { type: "string", description: "变更原因（可选）" },
        },
        required: ["sku", "paused"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_prepare_review_resolve",
      description:
        "登记人工处理命令（F14 两轨路由：仅 shopping 轨可执行；A2A 轨报「不可得」——绝不跨轨调 shopping-cli resolve-review）。",
      inputSchema: {
        type: "object",
        properties: {
          source_protocol: {
            type: "string",
            enum: ["a2a", "shopping"],
            description: "磋商来源轨道",
          },
          source_id: { type: "string", description: "轨道内 id（conversation_id）" },
          resolution: { type: "string", description: "处理结论" },
          reason: { type: "string", description: "变更原因（可选）" },
        },
        required: ["source_protocol", "source_id", "resolution"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_prepare_policy_change",
      description: "登记策略变更命令（F17：执行器写入后热生效，不重启进程；硬策略由执行器强制）。",
      inputSchema: {
        type: "object",
        properties: {
          patch: { type: "object", description: "策略变更字段（merchant_policy 键）" },
          reason: { type: "string", description: "变更原因（可选）" },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_prepare_products_import",
      description:
        "CSV 商品导入（prepare：解析预览 + 逐行回执，不执行）。相同幂等键不重复导入；批准后逐行执行，部分成功逐项回执。",
      inputSchema: {
        type: "object",
        properties: {
          csv: {
            type: "string",
            description:
              "CSV 文本（表头 sku,title,price,stock[,currency][,category][,description]）",
          },
          idempotency_key: { type: "string", description: "幂等键（可选；缺省按 CSV 内容 hash）" },
          reason: { type: "string", description: "变更原因（可选）" },
        },
        required: ["csv"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_prepare_products_withdraw",
      description:
        "批量撤回商品（listing 销售状态语义；prepare：只产候选，批准后执行；相同幂等键不重复撤回）。上游不支持时逐项回执明确失败。",
      inputSchema: {
        type: "object",
        properties: {
          skus: { type: "array", items: { type: "string" }, description: "要撤回的 SKU 列表" },
          idempotency_key: { type: "string", description: "幂等键（可选）" },
          reason: { type: "string", description: "变更原因（可选）" },
        },
        required: ["skus"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_get_operation",
      description:
        "查询长任务状态（operation_id；queued/running/succeeded/partially_failed/failed + 逐项回执）。",
      inputSchema: {
        type: "object",
        properties: { operation_id: { type: "string", description: "长任务 id" } },
        required: ["operation_id"],
        additionalProperties: false,
      },
    },
  ];

  const call = async (
    name: string,
    args: Record<string, unknown>,
    scopes?: string[],
  ): Promise<MerchantMcpCallResult> => {
    const handler = handlers[name];
    if (handler === undefined) {
      // 未知工具名：带内 isError（连接器统一处理），而非 JSON-RPC 协议错误。
      return errorResult(new MerchantWorkbenchError("validation", `未知工具 ${name}`));
    }
    // scope 强制校验（服务端逐次执行，不依赖 tools/list 展示过滤）。
    const required = requiredScopeForTool(name);
    if (!scopeAllows(scopes, required)) {
      return errorResult(
        new MerchantWorkbenchError(
          "auth",
          `scope 不足：${name} 需要 ${required}（当前授权：${(scopes ?? []).join(" ") || "无"}）`,
        ),
      );
    }
    try {
      const payload = await withTimeout(handler(args), timeoutMs);
      return okResult(payload, maxChars);
    } catch (err) {
      return errorResult(err);
    }
  };

  const listTools = (scopes?: string[]): MerchantMcpToolDefinition[] =>
    tools.filter((t) => scopeAllows(scopes, requiredScopeForTool(t.name)));

  return { tools, listTools, call };
}
