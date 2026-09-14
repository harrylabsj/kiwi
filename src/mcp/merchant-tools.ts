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
 * 写类工具（merchant_draft_product_change）只返回审批候选元数据，绝不直接执行。
 */

import type {
  DraftProductChangeResult,
  MerchantWorkbenchService,
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
  return {
    content: [
      {
        type: "text",
        text: `商家操作失败：${err instanceof Error ? err.message : String(err)}`,
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
              new MerchantWorkbenchError(
                "unavailable",
                `请求超时（${Math.round(timeoutMs / 1000)}s 上限）`,
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

/**
 * 构建 7 个 MVP 工具的定义与分发器。`call(name, args)` 返回 MCP CallToolResult
 * 形状；业务错误与未知工具名一律带内 isError 返回（中文说明）。
 */
export function buildMerchantMcpTools(
  service: MerchantWorkbenchService,
  options: MerchantMcpToolsOptions = {},
): {
  tools: MerchantMcpToolDefinition[];
  call: (name: string, args: Record<string, unknown>) => Promise<MerchantMcpCallResult>;
} {
  const maxChars = options.maxChars ?? MERCHANT_MCP_MAX_RESPONSE_CHARS;
  const timeoutMs = options.requestTimeoutMs ?? MERCHANT_MCP_REQUEST_TIMEOUT_MS;

  const handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  > = {
    merchant_list_products: async () => {
      const { items, source } = await service.listPublicProducts();
      return { count: items.length, source, items };
    },
    merchant_get_product: async (args) => {
      const product = await service.getPublicProduct(
        typeof args.sku === "string" ? args.sku : "",
        typeof args.merchant_id === "string" ? args.merchant_id : undefined,
      );
      return { product };
    },
    merchant_get_inventory: async (args) => {
      const snapshot = await service.getInventorySnapshot(
        typeof args.sku === "string" ? args.sku : "",
      );
      return { snapshot };
    },
    merchant_list_a2a_negotiations: async (args) => {
      const { total, items } = await service.listA2aNegotiations(args.limit);
      return { total, count: items.length, items };
    },
    merchant_list_human_reviews: async () => {
      const items = await service.listHumanReviews();
      return { count: items.length, items };
    },
    merchant_get_analytics: async (args) => {
      const snapshot = await service.getAnalytics(
        typeof args.period === "string" ? args.period : undefined,
      );
      return { snapshot };
    },
    merchant_draft_product_change: async (args) => {
      const result = await service.draftProductChange({
        sku: typeof args.sku === "string" ? args.sku : "",
        changes: args.changes,
        ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        ...(typeof args.merchant_id === "string" ? { merchant_id: args.merchant_id } : {}),
      });
      return draftResultPayload(result);
    },
  };

  const skuParam = { type: "string", description: "商品 SKU" } as const;
  const merchantIdParam = {
    type: "string",
    description: "租户校验（可选）：提供时必须等于本商家 merchant_id",
  } as const;

  const tools: MerchantMcpToolDefinition[] = [
    {
      name: "merchant_list_products",
      description: "列出商家自己的目录商品（只读；公开字段白名单，无私有底价/成本）。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "merchant_get_product",
      description: "按 SKU 读取商家目录中的一个商品（只读，公开字段白名单）。",
      inputSchema: {
        type: "object",
        properties: { sku: skuParam, merchant_id: merchantIdParam },
        required: ["sku"],
        additionalProperties: false,
      },
    },
    {
      name: "merchant_get_inventory",
      description: "读取一个商品的当前库存快照（含观察时间，不是永恒事实）。",
      inputSchema: {
        type: "object",
        properties: { sku: skuParam },
        required: ["sku"],
        additionalProperties: false,
      },
    },
    {
      name: "merchant_list_a2a_negotiations",
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
      name: "merchant_list_human_reviews",
      description: "查看商家需要人工处理的队列（升级、超预算/超底价、转人工的磋商）。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "merchant_get_analytics",
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
      name: "merchant_draft_product_change",
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
  ];

  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<MerchantMcpCallResult> => {
    const handler = handlers[name];
    if (handler === undefined) {
      // 未知工具名：带内 isError（连接器统一处理），而非 JSON-RPC 协议错误。
      return errorResult(new MerchantWorkbenchError("validation", `未知工具 ${name}`));
    }
    try {
      const payload = await withTimeout(handler(args), timeoutMs);
      return okResult(payload, maxChars);
    } catch (err) {
      return errorResult(err);
    }
  };

  return { tools, call };
}
