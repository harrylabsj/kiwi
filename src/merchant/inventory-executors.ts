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
 * Workbench 库存写入执行器（v1：带 operation receipt，**可对账**）。
 *
 * ## 为什么单独一个执行器、而不是继续用 merchant-core 里那条
 *
 * `merchant-core/executor.ts` 的库存条目走的是 legacy `client.updateInventory`
 * （`PATCH /products/{sku}`），**不落回执**。后果不是"少条日志"，而是：外部写一旦落进
 * UNKNOWN，`MerchantCommandLog.reconcile` 会因为没有 `queryOutcome` 适配器而直接返回
 * `unknown` +「no downstream operation query adapter」——**只能把候选永远挂在 UNKNOWN
 * 上升级人工，或者拿当前库存值去猜历史操作的结果**。两份 WB run 的 `not_verified`
 * 点名的就是这个。
 *
 * 注册表是「后写覆盖」（`MerchantExecutorRegistry` 用 `Map.set` 顺序写入，`extras`
 * 在 defaults 之后展开），所以本执行器以 extra 形式注册即**接管**同名工具，
 * merchant-core 的 legacy 条目保持不动——legacy 读面继续兼容，写面整条切到 v1。
 *
 * ## 四段契约（与 exact 商品执行器同口径）
 *
 * - `readPreconditions`：冻结候选时的前置快照（当前库存与货币表版本）；
 * - `execute`：用 **committed decision 的 operationId** 调 v1 端点，回执与效果同事务；
 * - `verifyAfter`：执行后回读，写入没落地就报错；
 * - `queryOutcome`：写后不确定时**按 operation_id 查下游回执**，匹配才判 succeeded。
 */

import type { MerchantClient } from "../agent/merchant/types.js";
import type { CommandExecutor } from "../merchant-core/executor.js";

export const INVENTORY_TOOLS = {
  update: "kiwi_merchant_prepare_inventory_update",
} as const;

export function createInventoryExecutors(options: {
  merchantId: string;
  client: MerchantClient;
}): CommandExecutor[] {
  return [
    {
      tool: INVENTORY_TOOLS.update,
      risk: "write_catalog",
      /**
       * **硬编码 true**（与 `createExactProductExecutors` 同口径，不跟
       * `ctx.requireCommittedProductDecisions` 走）：v1 端点**要求** `operation_id`，
       * 而它只能来自已提交的决定——**「有回执」与「有决定」是同一件事的两面**。
       *
       * 这是切到 v1 的代价，也是它可对账的原因：库存写入从此总要一次已提交的决定。
       * 若某条部署路径不开 `requireCommittedProductDecisions`，该路径下的库存写入会
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
          stock: current.stock,
          currency_table_version: current.currency_table_version,
          authority_version: current.authority_version,
        };
      },
      execute: async (args, _context, decision) => {
        const sku = requireText(args["sku"], "sku");
        const stock = requireNonNegativeInteger(args["stock"], "stock");
        // v1 端点要求 `currency_table_version`（v1 面统一前置）。库存命令的 args 里
        // 没有货币信息——它不是金额变更——故从当前 exact 商品读。这次读同时验证了该
        // 商品确实在 exact 线上，而回执投影正依赖这一前提。
        const current = await options.client.getExactProduct(options.merchantId, sku);
        return await options.client.updateInventoryExact({
          operation_id: requireCommitted(decision).operationId,
          merchant_id: options.merchantId,
          sku,
          stock,
          currency_table_version: current.currency_table_version,
        });
      },
      verifyAfter: async (args) => {
        const value = await options.client.getExactProduct(
          options.merchantId,
          requireText(args["sku"], "sku"),
        );
        if (value.stock !== requireNonNegativeInteger(args["stock"], "stock")) {
          throw new Error("inventory update readback failed");
        }
      },
      queryOutcome: async (args, _context, decision) => {
        const operation = await options.client.getProductOperation(
          options.merchantId,
          decision.operationId,
        );
        return operation.operation_kind === "product_inventory_update" &&
          operation.sku === requireText(args["sku"], "sku")
          ? { status: "succeeded" }
          : { status: "unknown", error: "inventory receipt does not match" };
      },
    },
  ];
}

function requireCommitted(
  value: { kind: "committed"; operationId: string; actorId: string } | undefined,
): { operationId: string; actorId: string } {
  if (value?.kind !== "committed") {
    throw new Error("inventory execution requires a committed decision");
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return Number(value);
}
