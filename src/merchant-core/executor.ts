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
 * 固定执行器注册表（V2 阶段三：src/merchant-core/executor.ts）。
 *
 * 执行器按 tool 名**静态注册**（禁止动态/字符串拼接分发到任意函数）——
 * 注册表在进程启动时一次建成，未知 tool 名 fail-closed。每个执行器提供：
 *   - readPreconditions(args)：重读目标对象当前状态（前置版本/digest）；
 *   - execute(args)：执行已批准参数（只执行命令记录里存储的参数）；
 *   - verifyAfter?：执行后回读校验（写链路闭环的回读环节）。
 *
 * 恢复语义：进程重启后从命令记录（approval store）恢复 pending 时，钩子
 * 由注册表按存储的 tool/arguments 确定性重建——不依赖任何进程内闭包。
 */

import type { MerchantClient, MerchantProductPatch } from "../agent/merchant/types.js";
import { parseProductCreateInput } from "../agent/merchant/types.js";
import type { AgentProfile, MerchantPolicy } from "../config/profile.js";
import { publicProductView } from "../merchant/workbench-service.js";
import { executeProductsImport } from "./product-import.js";
import type { ApplyPolicyResult } from "./policy-runtime.js";
import type { MerchantOperationStore } from "./operations.js";

/** 执行器上下文（只读依赖 + 策略写接缝）。 */
export interface ExecutorContext {
  merchantClient: MerchantClient;
  profile: AgentProfile;
  /** 商家 owner_id（导入/撤回执行归属）。 */
  ownerId: string;
  /** 长任务 operation store（CSV 导入/撤回等；缺省时相关执行器 fail-closed）。 */
  operations?: MerchantOperationStore;
  /** 策略热更新写入（F17/BUG-07）：校验+原子写完整生效策略，返回版本/digest。 */
  applyPolicyOverride?:
    | ((patch: Record<string, unknown>) => Promise<ApplyPolicyResult>)
    | ((patch: Record<string, unknown>) => ApplyPolicyResult);
  /** 运行中策略读取（BUG-07）：配置后硬策略（底价兜底）按当前生效策略执行，
   *  不再固定用启动 profile 的 merchant_policy。 */
  currentPolicy?: () => MerchantPolicy | undefined;
  /** F14 两轨人工处理：shopping 轨 resolve（A2A 轨绝不进这里）。 */
  resolveShoppingReview?: (input: {
    conversation_id: string;
    resolution: string;
  }) => Promise<unknown>;
}

/** 固定执行器（一个 tool 一个）。 */
export interface CommandExecutor {
  readonly tool: string;
  /** 重读目标对象前置状态（版本/digest 比对用）。 */
  readPreconditions(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 执行已批准参数。 */
  execute(args: Record<string, unknown>, ctx: ExecutorContext): Promise<unknown>;
  /** 执行后回读校验（可选；返回 false/抛错 = 回读不一致）。 */
  verifyAfter?(args: Record<string, unknown>, ctx: ExecutorContext): Promise<void>;
}

export class MerchantExecutorRegistry {
  private readonly registry = new Map<string, CommandExecutor>();

  private constructor(executors: CommandExecutor[]) {
    for (const e of executors) this.registry.set(e.tool, e);
  }

  /** 静态构造（固定白名单；新增写面必须显式加执行器）。 */
  static buildDefault(ctx: ExecutorContext): MerchantExecutorRegistry {
    const productPreconditions = async (args: Record<string, unknown>) => {
      const sku = String(args.sku ?? "");
      return publicProductView(await ctx.merchantClient.getProduct(sku));
    };
    /** 硬策略强制（执行器层兜底）：价格变更不得低于私有底价（BUG-07：按
     *  运行中生效策略校验，未配置运行中策略时回退启动 profile）。price 为
     *  undefined = 本次变更不涉及价格（跳过）；非有限数值一律拒绝（审查 P1：
     *  恒 false 比较会让底价检查纸面化）。 */
    const enforceFloor = (price: unknown): void => {
      if (price === undefined) return;
      const floor =
        ctx.currentPolicy?.()?.min_unit_price_private ??
        ctx.profile.merchant_policy?.min_unit_price_private;
      if (floor === undefined) return;
      if (typeof price !== "number" || !Number.isFinite(price)) {
        throw new Error("执行被硬策略拒绝：price 不是有限数值（不透出底价数值）");
      }
      if (price < floor) {
        throw new Error("执行被硬策略拒绝：价格低于私有底价（不透出底价数值）");
      }
    };
    return new MerchantExecutorRegistry([
      // V1 草稿候选（内部 tool 名不变——写门/恢复机制的历史标识）
      {
        tool: "draft_product_change",
        readPreconditions: productPreconditions,
        execute: async (args, c) => {
          const changes = (args.changes ?? {}) as MerchantProductPatch;
          enforceFloor(typeof changes.price === "number" ? changes.price : undefined);
          return c.merchantClient.updateProduct(String(args.sku), changes);
        },
        verifyAfter: async (args, _c) => {
          await productPreconditions(args); // 回读可达性校验（§16 前置重哈希已比内容）
        },
      },
      {
        tool: "kiwi_merchant_prepare_product_create",
        // 审查 P1：执行前白名单重校验并钉死 merchant_id 归属——prepare 层
        // 已校验（service），这里防御 store 参数被篡改/迁移旧库缺校验。
        readPreconditions: async (args) => {
          const product = (args.product ?? {}) as { sku?: string };
          const sku = String(product.sku ?? "");
          // 已存在则旧授权失效（stale → superseded，见 executeApprovedCandidate）
          let exists = false;
          try {
            await ctx.merchantClient.getProduct(sku);
            exists = true;
          } catch {
            exists = false;
          }
          return { sku, exists };
        },
        execute: async (args, c) => {
          const product = parseProductCreateInput(args.product, c.ownerId);
          enforceFloor(product.price);
          return c.merchantClient.createProduct(product);
        },
      },
      {
        tool: "kiwi_merchant_prepare_product_update",
        readPreconditions: productPreconditions,
        execute: async (args, c) => {
          const changes = (args.changes ?? {}) as MerchantProductPatch;
          enforceFloor(typeof changes.price === "number" ? changes.price : undefined);
          return c.merchantClient.updateProduct(String(args.sku), changes);
        },
      },
      {
        tool: "kiwi_merchant_prepare_inventory_update",
        readPreconditions: productPreconditions,
        execute: async (args, c) =>
          c.merchantClient.updateInventory(String(args.sku), Number(args.stock)),
      },
      {
        // F08 语义落地：销售状态（paused flag）；上游 shopping-cli 2.x 无端点
        // → client fail-closed 报「不可得」（不库存写零伪装下架）。
        tool: "kiwi_merchant_prepare_listing_change",
        readPreconditions: productPreconditions,
        execute: async (args, c) =>
          c.merchantClient.pauseListing(String(args.sku), args.paused === true),
      },
      {
        // F14 两轨人工处理：executor 只接 shopping 轨（路由守卫在命令准备层）；
        // A2A 轨人审由 A2A 侧机制处理，绝不进 shopping resolve。
        tool: "kiwi_merchant_prepare_review_resolve",
        readPreconditions: async (args) => ({
          source_id: String(args.source_id ?? ""),
        }),
        execute: async (args, c) => {
          if (c.resolveShoppingReview === undefined) {
            throw new Error("shopping 轨人工处理接口未配置（不可得）");
          }
          return c.resolveShoppingReview({
            conversation_id: String(args.source_id),
            resolution: String(args.resolution ?? ""),
          });
        },
      },
      {
        // F17 策略变更热更新（BUG-07）：执行器经共享策略提供器校验+原子写
        // 完整生效策略，A2A/执行器按运行中策略立即生效；回执带版本/digest。
        tool: "kiwi_merchant_prepare_policy_change",
        readPreconditions: async () => ({ scope: "merchant_policy" }),
        execute: async (args, c) => {
          if (c.applyPolicyOverride === undefined) {
            throw new Error("策略热更新接缝未配置（不可得）");
          }
          const patch = (args.patch ?? {}) as Record<string, unknown>;
          const result = await c.applyPolicyOverride(patch);
          return {
            applied: true,
            version: result.version,
            digest: result.digest,
            updated_at: result.updated_at,
            applied_keys: result.applied_keys,
          };
        },
      },
      {
        // F04 CSV 导入（长任务 + 幂等键 + 逐项回执）。
        tool: "kiwi_merchant_prepare_products_import",
        // 幂等由 operation store 承载（同幂等键返回同一 operation），前置版本
        // 用静态摘要（导入是批量意图，不因目录其他变化失效）。
        readPreconditions: async (args) => ({
          idempotency_key: String(args.idempotency_key ?? ""),
          lines: String(args.csv ?? "")
            .split(/\r?\n/)
            .filter((l) => l.trim() !== "").length,
        }),
        execute: async (args, c) => {
          if (c.operations === undefined) {
            throw new Error("operation store 未配置（不可得）");
          }
          return executeProductsImport({
            csv: String(args.csv ?? ""),
            idempotencyKey: String(args.idempotency_key ?? ""),
            merchantId: c.ownerId,
            merchantClient: c.merchantClient,
            operations: c.operations,
          });
        },
      },
      {
        // F04 撤回（listing 销售状态语义；上游无端点 → 逐项回执失败，不库存写零）。
        tool: "kiwi_merchant_prepare_products_withdraw",
        readPreconditions: async (args) => ({
          skus: Array.isArray(args.skus) ? args.skus.length : 0,
        }),
        execute: async (args, c) => {
          if (c.operations === undefined) {
            throw new Error("operation store 未配置（不可得）");
          }
          const skus = Array.isArray(args.skus) ? args.skus.map(String) : [];
          const op = c.operations.createOrGet({
            kind: "products_withdraw",
            idempotencyKey: String(args.idempotency_key ?? ""),
          });
          if (!op.created) return op.operation; // 幂等：不重复撤回
          c.operations.markRunning(op.operation.operation_id);
          const receipts = [];
          for (const sku of skus) {
            try {
              await c.merchantClient.pauseListing(sku, true);
              receipts.push({ item: sku, ok: true });
            } catch (err) {
              receipts.push({
                item: sku,
                ok: false,
                detail: err instanceof Error ? err.message : String(err),
              });
            }
          }
          const finished = c.operations.finish(op.operation.operation_id, receipts);
          // 全部项失败 → ok:false（审查 P1：否则候选仍被标 executed，审计谎报成功）
          return finished.status === "failed" ? { ok: false, operation: finished } : finished;
        },
      },
    ]);
  }

  get(tool: string): CommandExecutor | undefined {
    return this.registry.get(tool);
  }

  has(tool: string): boolean {
    return this.registry.has(tool);
  }

  tools(): string[] {
    return [...this.registry.keys()];
  }
}
