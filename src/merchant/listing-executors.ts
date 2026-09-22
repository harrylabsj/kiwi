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
 * Workbench 上下架写入执行器（v1：带 operation receipt，**可对账**）。
 *
 * ## 为什么单独一个执行器、而不是继续用 merchant-core 里那条
 *
 * `merchant-core/executor.ts` 的上下架条目走 legacy `client.pauseListing`——上游
 * 此前**连状态都没有**（listings/* 全是 products 的只读投影），真实 Connector 只能
 * fail-closed 报「不可得」（刻意不用库存写零伪装下架）。没有真实状态可写，就没有
 * 可对账的回执：外部写一旦落进 UNKNOWN，`MerchantCommandLog.reconcile` 会因为没有
 * `queryOutcome` 适配器而直接返回 `unknown` +「no downstream operation query
 * adapter」——**只能把候选永远挂在 UNKNOWN 上升级人工**。
 *
 * 上游 schema v31 起有了真实端点（`PATCH /v1/merchant/products/{sku}/listing`，
 * 写 `products.listing_paused` + 同事务回执）。注册表是「后写覆盖」
 * （`MerchantExecutorRegistry` 用 `Map.set` 顺序写入，`extras` 在 defaults 之后
 * 展开），所以本执行器以 extra 形式注册即**接管**同名工具，merchant-core 的
 * legacy 条目保持不动——legacy 读面继续兼容，写面整条切到 v1。
 *
 * ## 四段契约（与库存执行器同口径）
 *
 * - `readPreconditions`：冻结候选时的前置快照（当前销售状态与货币表版本）；
 * - `execute`：用 **committed decision 的 operationId** 调 v1 端点，回执与效果同事务；
 * - `verifyAfter`：执行后回读，写入没落地就报错；
 * - `queryOutcome`：写后不确定时**按 operation_id 查下游回执**，kind/sku/paused
 *   目标态全部匹配才判 succeeded——回执响应体里的目标态与请求语义不一致，说明
 *   那张回执属于**另一次**写（同 id 同 sku 异 paused 上游按冲突拒绝），不得据它判成功。
 */

import type { MerchantClient } from "../agent/merchant/types.js";
import type { CommandExecutor } from "../merchant-core/executor.js";

export const LISTING_TOOLS = {
  change: "kiwi_merchant_prepare_listing_change",
} as const;

export function createListingExecutors(options: {
  merchantId: string;
  client: MerchantClient;
}): CommandExecutor[] {
  return [
    {
      tool: LISTING_TOOLS.change,
      risk: "write_catalog",
      /**
       * **硬编码 true**（与库存/exact 商品执行器同口径，不跟
       * `ctx.requireCommittedProductDecisions` 走）：v1 端点**要求** `operation_id`，
       * 而它只能来自已提交的决定——**「有回执」与「有决定」是同一件事的两面**。
       *
       * 这是切到 v1 的代价，也是它可对账的原因：上下架写入从此总要一次已提交的决定。
       * 若某条部署路径不开 `requireCommittedProductDecisions`，该路径下的上下架写入会
       * 因为没有决定而不可用——那是刻意的 fail-closed，不是回归。
       */
      requiresCommittedDecision: true,
      readPreconditions: async (args) => {
        const current = await options.client.getExactProduct(
          options.merchantId,
          requireText(args["sku"], "sku"),
        );
        return {
          sku: current.sku,
          listing_paused: current.listing_paused,
          currency_table_version: current.currency_table_version,
          authority_version: current.authority_version,
        };
      },
      execute: async (args, _context, decision) => {
        const sku = requireText(args["sku"], "sku");
        // paused 是方向性语义字段：宽松 truthy 转换会把「恢复销售」静默执行成
        // 「暂停销售」。只接受严格 bool（上游同样严格校验，这里先拦一道）。
        const paused = requireBoolean(args["paused"], "paused");
        // v1 端点要求 `currency_table_version`（v1 面统一前置）。上下架命令的 args 里
        // 没有货币信息——它不是金额变更——故从当前 exact 商品读。这次读同时验证了该
        // 商品确实在 exact 线上，而回执投影正依赖这一前提。
        const current = await options.client.getExactProduct(options.merchantId, sku);
        return await options.client.updateListingExact({
          operation_id: requireCommitted(decision).operationId,
          merchant_id: options.merchantId,
          sku,
          paused,
          currency_table_version: current.currency_table_version,
        });
      },
      verifyAfter: async (args) => {
        const value = await options.client.getExactProduct(
          options.merchantId,
          requireText(args["sku"], "sku"),
        );
        // listing_paused 缺字段（更老网关）按不可判定 fail-closed——不得当成
        // 写入成功，也不得当成 false 通过校验。
        if (value.listing_paused !== requireBoolean(args["paused"], "paused")) {
          throw new Error("listing change readback failed");
        }
      },
      queryOutcome: async (args, _context, decision) => {
        const operation = await options.client.getProductOperation(
          options.merchantId,
          decision.operationId,
        );
        const paused = requireBoolean(args["paused"], "paused");
        const receiptProduct = operation.result?.["product"];
        const receiptPaused =
          receiptProduct !== null && typeof receiptProduct === "object"
            ? (receiptProduct as Record<string, unknown>)["listing_paused"]
            : undefined;
        return operation.operation_kind === "product_listing_change" &&
          operation.sku === requireText(args["sku"], "sku") &&
          receiptPaused === paused
          ? { status: "succeeded" }
          : { status: "unknown", error: "listing receipt does not match" };
      },
    },
  ];
}

function requireCommitted(
  value: { kind: "committed"; operationId: string; actorId: string } | undefined,
): { operationId: string; actorId: string } {
  if (value?.kind !== "committed") {
    throw new Error("listing execution requires a committed decision");
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}
