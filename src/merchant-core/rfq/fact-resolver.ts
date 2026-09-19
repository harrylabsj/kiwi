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
 * 事实快照解析（设计 v0.1.1 §5.1 步骤四、§6.3、§6.4）。
 *
 *   - 经营事实只经 CommerceDataSource（shopping-cli 唯一数据入口）读取；
 *     不在 Kiwi 再造 ERP 连接层或第二个商品主库。
 *   - 每字段记录权威（LOCAL_AUTHORITATIVE/UPSTREAM_PROXY/READ_ONLY）、来源、
 *     verified_at 与新鲜度阈值；冲突权威由数据侧 fail-closed，这里不静默择优。
 *   - 事实指纹只包含业务值、权威来源（与源标识）与源版本；verified_at /
 *     expires_at 不进入内容指纹——单纯重读时间变化不使审批必然失效，新鲜度
 *     单独检查。源版本由数据源显式提供（CommerceField.source_version），
 *     绝不从 verified_at 派生（读取时间不是版本）；无版本的自权威数据以
 *     "local-authoritative" 稳定标记声明——值变化经 value 进入指纹即失效。
 *   - 建议阈值：库存 60 秒、价格 300 秒（v0.1.1 §6.3，试点可调参数）。
 */

import type { CommerceDataSource, ProductFact } from "../../commerce/data-source.js";
import { CommerceError } from "../../commerce/data-source.js";
import { rfqContentDigest, RfqError, type FactAuthority, type FactField } from "./types.js";

/** 新鲜度建议阈值（秒；试点参数，不是行业事实）。 */
export const FRESHNESS_SECONDS = {
  inventory: 60,
  price: 300,
  rules: 24 * 60 * 60,
} as const;

/** 部署可调的新鲜度阈值（缺省用 FRESHNESS_SECONDS；§6.3 试点参数）。 */
export type FreshnessOverrides = Partial<Record<keyof typeof FRESHNESS_SECONDS, number>>;

export interface FactSnapshotDraft {
  snapshot_id: string;
  merchant_id: string;
  case_id: string;
  case_revision: number;
  fetched_at: string;
  fields: FactField[];
  content_fingerprint: string;
  complete: boolean;
  source_version: string | null;
  synthetic: boolean;
}

function isoAt(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/** 自权威数据的稳定版本标记：无外部版本号，值变化经 value 进入指纹（FA-07）。 */
const LOCAL_AUTHORITY_VERSION = "local-authoritative";

function toField(input: {
  field_path: string;
  value: FactField["value"];
  authority: FactAuthority;
  source: string;
  verified_at?: string;
  /** 上游显式提供的源版本；缺省 "unknown"（发布硬门阻断，§6.3）。 */
  sourceVersion?: string;
  freshForSeconds?: number;
  /** 缺省新鲜期（未显式给 freshForSeconds 的字段用；部署可调）。 */
  defaultFreshSeconds?: number;
  nowIso: string;
}): FactField {
  // 上游未提供 verified_at 时如实记读取时点；source_version 只来自显式
  // 透传，绝不从 verified_at 派生——读取时间不是版本（FA-07：不用读取
  // 时间伪造验证）。source_version === "unknown" 的关键字段在发布硬门阻断。
  const verified_at = input.verified_at ?? input.nowIso;
  return {
    field_path: input.field_path,
    value: input.value,
    authority: input.authority,
    source: input.source,
    source_version: input.sourceVersion ?? "unknown",
    verified_at,
    expires_at: isoAt(verified_at, input.freshForSeconds ?? input.defaultFreshSeconds ?? FRESHNESS_SECONDS.rules),
    visibility: "model_public",
  };
}

/** 指纹只含业务值 + 权威 + 来源 + 源版本；时间字段剔除（§6.3）。 */
export function factFingerprint(fields: FactField[]): string {
  const stable = fields.map((f) => ({
    field_path: f.field_path,
    value: f.value,
    authority: f.authority,
    source: f.source,
    source_version: f.source_version,
  }));
  return rfqContentDigest(stable);
}

async function safePrice(
  dataSource: CommerceDataSource,
  sku: string,
): Promise<{ currency: string; amount_minor: number; authority: FactAuthority; source: string; verified_at?: string; source_version?: string } | undefined> {
  try {
    const field = await dataSource.getPrice(sku);
    if (field === undefined) return undefined;
    return {
      currency: field.value.currency,
      amount_minor: field.value.amount_minor,
      authority: field.authority,
      source: field.source,
      ...(field.verified_at !== undefined ? { verified_at: field.verified_at } : {}),
      ...(field.source_version !== undefined ? { source_version: field.source_version } : {}),
    };
  } catch (err) {
    if (err instanceof CommerceError && err.code === "not_found") return undefined;
    throw err;
  }
}

async function safeInventory(
  dataSource: CommerceDataSource,
  sku: string,
): Promise<{ value: number; authority: FactAuthority; source: string; verified_at?: string; source_version?: string } | undefined> {
  try {
    const field = await dataSource.getInventory(sku);
    return field === undefined ? undefined : { ...field };
  } catch (err) {
    if (err instanceof CommerceError && err.code === "not_found") return undefined;
    throw err;
  }
}

function availabilityOf(product: ProductFact): "in_stock" | "out_of_stock" | "unknown" {
  if (product.availability_hint === "in_stock" || product.availability_hint === "out_of_stock") {
    return product.availability_hint;
  }
  if (typeof product.stock === "number") return product.stock > 0 ? "in_stock" : "out_of_stock";
  return "unknown";
}

/**
 * 为一版需求建立事实快照：对每个已确认 SKU 读公开价与库存；未知库存记
 * unknown（绝不把缺字段当 0）。价格/库存读取失败 fail-closed（源不可用
 * 不降级为演示价）。
 */
export async function resolveFactSnapshot(input: {
  dataSource: CommerceDataSource;
  merchantId: string;
  caseId: string;
  caseRevision: number;
  skus: string[];
  snapshotId: string;
  nowIso: string;
  /** 部署可调阈值（缺省 FRESHNESS_SECONDS；§6.3 试点参数）。 */
  freshness?: FreshnessOverrides;
}): Promise<FactSnapshotDraft> {
  const thresholds = { ...FRESHNESS_SECONDS, ...(input.freshness ?? {}) };
  const fields: FactField[] = [];
  const uniqueSkus = [...new Set(input.skus)].sort();
  for (const sku of uniqueSkus) {
    let product: ProductFact | undefined;
    try {
      product = await input.dataSource.getProduct(sku);
    } catch (err) {
      if (err instanceof CommerceError && err.code === "not_found") {
        product = undefined;
      } else {
        throw new RfqError("source_unavailable", `SKU ${sku} 事实读取失败（fail-closed，不降级为演示价）`);
      }
    }
    if (product === undefined) {
      fields.push(
        toField({
          field_path: `products.${sku}.exists`,
          value: false,
          authority: "LOCAL_AUTHORITATIVE",
          source: "shopping-cli",
          // 本地推导字段：读取时即观察到（诚实时间戳，非上游伪造）。
          verified_at: input.nowIso,
          sourceVersion: LOCAL_AUTHORITY_VERSION,
          ...(input.freshness !== undefined ? { defaultFreshSeconds: thresholds.rules } : {}),
          nowIso: input.nowIso,
        }),
      );
      continue;
    }
    const price = await safePrice(input.dataSource, sku);
    if (price === undefined) {
      fields.push(
        toField({
          field_path: `products.${sku}.price_minor`,
          value: null,
          authority: "LOCAL_AUTHORITATIVE",
          source: "shopping-cli",
          sourceVersion: LOCAL_AUTHORITY_VERSION,
          ...(input.freshness !== undefined ? { defaultFreshSeconds: thresholds.rules } : {}),
          nowIso: input.nowIso,
        }),
      );
    } else {
      fields.push(
        toField({
          field_path: `products.${sku}.price_minor`,
          value: price.amount_minor,
          authority: price.authority,
          source: price.source,
          ...(price.verified_at !== undefined ? { verified_at: price.verified_at } : {}),
          sourceVersion: price.source_version,
          freshForSeconds: thresholds.price,
          ...(input.freshness !== undefined ? { defaultFreshSeconds: thresholds.rules } : {}),
          nowIso: input.nowIso,
        }),
      );
      fields.push(
        toField({
          field_path: `products.${sku}.currency`,
          value: price.currency,
          authority: price.authority,
          source: price.source,
          ...(price.verified_at !== undefined ? { verified_at: price.verified_at } : {}),
          sourceVersion: price.source_version,
          freshForSeconds: thresholds.price,
          ...(input.freshness !== undefined ? { defaultFreshSeconds: thresholds.rules } : {}),
          nowIso: input.nowIso,
        }),
      );
    }
    const inventory = await safeInventory(input.dataSource, sku);
    const availability = availabilityOf(product);
    fields.push(
      toField({
        field_path: `products.${sku}.stock`,
        // 库存不可得记 null（未知 ≠ 0）；availability_hint 独立记录。
        value: inventory === undefined ? null : inventory.value,
        authority: inventory?.authority ?? "LOCAL_AUTHORITATIVE",
        source: inventory?.source ?? "shopping-cli",
        ...(inventory?.verified_at !== undefined ? { verified_at: inventory.verified_at } : {}),
        sourceVersion: inventory?.source_version,
        freshForSeconds: thresholds.inventory,
        ...(input.freshness !== undefined ? { defaultFreshSeconds: thresholds.rules } : {}),
        nowIso: input.nowIso,
      }),
    );
    fields.push(
      toField({
        field_path: `products.${sku}.availability`,
        value: availability,
        authority: "LOCAL_AUTHORITATIVE",
        source: "shopping-cli",
        verified_at: input.nowIso,
        sourceVersion: LOCAL_AUTHORITY_VERSION,
        ...(input.freshness !== undefined ? { defaultFreshSeconds: thresholds.rules } : {}),
        nowIso: input.nowIso,
      }),
    );
  }
  return {
    snapshot_id: input.snapshotId,
    merchant_id: input.merchantId,
    case_id: input.caseId,
    case_revision: input.caseRevision,
    fetched_at: input.nowIso,
    fields,
    content_fingerprint: factFingerprint(fields),
    complete: true,
    source_version: null,
    synthetic: false,
  };
}

/** 字段是否过期（快照内 expires_at 与服务端当前时间比较）。 */
export function isFieldStale(field: FactField, nowIso: string): boolean {
  if (field.expires_at === undefined) return false;
  return Date.parse(field.expires_at) <= Date.parse(nowIso);
}

/** 关键事实过期/缺源版本评估（发布前置校验用；返回阻断原因）。 */
export function evaluateFreshness(
  fields: FactField[],
  nowIso: string,
): { stale: string[]; missing_verification: string[] } {
  const stale = fields.filter((f) => isFieldStale(f, nowIso)).map((f) => f.field_path);
  // source_version "unknown" = 上游未提供验证/版本信息（如实记录，发布阻断）。
  const missing_verification = fields
    .filter((f) => f.source_version === "unknown" && f.value !== null)
    .map((f) => f.field_path);
  return { stale, missing_verification };
}
