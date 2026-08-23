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
 * 产品层 `kiwi buyer supplier` 命令实现（pull-relationship 设计 v0.1 §11，M1）。
 *
 * 关系是 Buyer Core 本地私有状态：save/watch/prefer 通过 kiwi-catalog 解析
 * Merchant 公开 record（canonical_domain / agent_card_url / ucp_profile_url），
 * 写入本地 supplier_relationships；Merchant 侧无任何写入通道。
 *
 * watched / preferred 默认要求人类明确确认（consent_source = human_explicit）：
 * 非交互环境必须显式传 --yes，否则拒绝。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { agentDataDir, openAgentDatabase } from "./agent/agent-db.js";
import {
  SupplierRelationshipStore,
  type SupplierRelationship,
  type SupplierRelationshipType,
} from "./agent/supplier/store.js";
import { KiwiCatalogSource } from "./discovery/catalog-source/kiwi-source.js";
import { DEFAULT_CATALOG_URL } from "./product-cli.js";

export interface SupplierCommandOptions {
  dataDir?: string;
  agentId?: string;
}

export interface SupplierSummary {
  relationship_id: string;
  merchant_id: string;
  canonical_domain: string;
  relationship_type: SupplierRelationshipType;
  status: string;
  consent_source: string;
  scope: Record<string, unknown>;
  policy: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  expires_at?: string;
}

function openSupplierStore(options: SupplierCommandOptions): {
  db: DatabaseSync;
  store: SupplierRelationshipStore;
} {
  const dataDir = options.dataDir ?? agentDataDir(options.agentId ?? "kiwi-assistant");
  const dbPath = path.join(dataDir, "state.sqlite");
  if (!existsSync(dbPath)) {
    throw new Error(
      `没有 Buyer 数据（${dbPath} 不存在）——先运行 \`kiwi buyer start\` 初始化本地 Buyer Core`,
    );
  }
  const db = openAgentDatabase(dbPath);
  try {
    const principal = db
      .prepare("SELECT principal_id FROM principals WHERE role = 'buyer' ORDER BY created_at LIMIT 1")
      .get() as { principal_id: string } | undefined;
    if (principal === undefined) {
      throw new Error("本地 Buyer principal 不存在——先运行 `kiwi buyer start` 完成初始化");
    }
    const store = new SupplierRelationshipStore({ db, principalId: principal.principal_id });
    return { db, store };
  } catch (err) {
    db.close();
    throw err;
  }
}

/** 从 kiwi-catalog 解析 Merchant 公开 record（save/watch/prefer 共用的身份来源）。 */
async function resolveMerchant(catalogUrl: string, merchantId: string): Promise<{
  merchant_id: string;
  catalog_agent_id: string;
  canonical_domain: string;
  agent_card_url: string;
  ucp_profile_url?: string;
}> {
  const source = new KiwiCatalogSource({ baseUrl: catalogUrl });
  const record = await source.getRecord(merchantId);
  if (record.agent_card_url === undefined) {
    throw new Error(`catalog record ${merchantId} 没有 agent_card_url，无法建立供应商关系`);
  }
  return {
    merchant_id: record.merchant_id ?? record.catalog_agent_id,
    catalog_agent_id: record.catalog_agent_id,
    canonical_domain: record.canonical_domain,
    agent_card_url: record.agent_card_url,
    ...(record.ucp_profile_url !== undefined ? { ucp_profile_url: record.ucp_profile_url } : {}),
  };
}

/**
 * watched/preferred 的明确同意门（§11：创建 watched/preferred 默认要求人类
 * 明确确认）。--yes 或交互确认通过才返回；否则抛错拒绝。
 */
async function requireExplicitConsent(options: {
  yes?: boolean;
  confirm?: () => Promise<boolean>;
  action: string;
}): Promise<void> {
  if (options.yes === true) return;
  if (options.confirm !== undefined && (await options.confirm())) return;
  throw new Error(
    `${options.action} 需要人类明确确认：交互终端请确认提示，非交互环境请显式加 --yes`,
  );
}

function summarize(rel: SupplierRelationship): SupplierSummary {
  const out: SupplierSummary = {
    relationship_id: rel.relationship_id,
    merchant_id: rel.merchant_id,
    canonical_domain: rel.canonical_domain,
    relationship_type: rel.relationship_type,
    status: rel.status,
    consent_source: rel.consent_source,
    scope: rel.scope,
    policy: rel.policy,
    created_at: rel.created_at,
    updated_at: rel.updated_at,
  };
  if (rel.expires_at !== undefined) out.expires_at = rel.expires_at;
  return out;
}

function parseExpiresDays(value: string): string {
  const match = /^(\d+)d$/.exec(value);
  if (match === null) {
    throw new Error("--expires 只支持 <N>d 形式（如 90d）");
  }
  const days = Number(match[1]);
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("--expires 天数必须是正整数");
  }
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

export interface SupplierSaveOptions extends SupplierCommandOptions {
  merchantId: string;
  catalogUrl?: string;
}

/** `kiwi buyer supplier save <merchant-id>`：保存身份，不轮询（§2.1）。 */
export async function supplierSave(options: SupplierSaveOptions): Promise<SupplierSummary> {
  const resolved = await resolveMerchant(options.catalogUrl ?? DEFAULT_CATALOG_URL, options.merchantId);
  const { db, store } = openSupplierStore(options);
  try {
    return summarize(
      store.saveRelationship({
        merchant_id: resolved.merchant_id,
        canonical_domain: resolved.canonical_domain,
        agent_card_url: resolved.agent_card_url,
        ...(resolved.ucp_profile_url !== undefined
          ? { ucp_profile_url: resolved.ucp_profile_url }
          : {}),
        relationship_type: "saved",
        scope: { catalog_agent_id: resolved.catalog_agent_id },
        consent_source: "human_explicit",
      }),
    );
  } finally {
    db.close();
  }
}

export interface SupplierWatchOptions extends SupplierCommandOptions {
  merchantId: string;
  catalogUrl?: string;
  query?: string;
  region?: string;
  /** 轮询间隔（秒）；缺省 6h，下限 1h（§8：不做分钟级轮询）。 */
  intervalSeconds?: number;
  yes?: boolean;
  confirm?: () => Promise<boolean>;
}

/** `kiwi buyer supplier watch <merchant-id>`：建立主动观察规则（§2.2）。 */
export async function supplierWatch(options: SupplierWatchOptions): Promise<SupplierSummary> {
  await requireExplicitConsent({ yes: options.yes, confirm: options.confirm, action: "watch" });
  if (
    options.intervalSeconds !== undefined &&
    (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 3600)
  ) {
    throw new Error("--interval 必须是 ≥3600 的整数秒（供应商观察不做分钟级轮询）");
  }
  const resolved = await resolveMerchant(options.catalogUrl ?? DEFAULT_CATALOG_URL, options.merchantId);
  const { db, store } = openSupplierStore(options);
  try {
    return summarize(
      store.saveRelationship({
        merchant_id: resolved.merchant_id,
        canonical_domain: resolved.canonical_domain,
        agent_card_url: resolved.agent_card_url,
        ...(resolved.ucp_profile_url !== undefined
          ? { ucp_profile_url: resolved.ucp_profile_url }
          : {}),
        relationship_type: "watched",
        scope: {
          catalog_agent_id: resolved.catalog_agent_id,
          ...(options.query !== undefined ? { query: options.query } : {}),
          ...(options.region !== undefined ? { region: options.region } : {}),
        },
        policy:
          options.intervalSeconds !== undefined
            ? { interval_seconds: options.intervalSeconds }
            : {},
        consent_source: "human_explicit",
      }),
    );
  } finally {
    db.close();
  }
}

export interface SupplierPreferOptions extends SupplierCommandOptions {
  merchantId: string;
  catalogUrl?: string;
  scope?: string;
  /** 如 "90d"（§11 CLI 形式）。 */
  expires?: string;
  yes?: boolean;
  confirm?: () => Promise<boolean>;
}

/** `kiwi buyer supplier prefer <merchant-id>`：采购范围内的软偏好（§2.3）。 */
export async function supplierPrefer(options: SupplierPreferOptions): Promise<SupplierSummary> {
  await requireExplicitConsent({ yes: options.yes, confirm: options.confirm, action: "prefer" });
  const resolved = await resolveMerchant(options.catalogUrl ?? DEFAULT_CATALOG_URL, options.merchantId);
  const { db, store } = openSupplierStore(options);
  try {
    return summarize(
      store.saveRelationship({
        merchant_id: resolved.merchant_id,
        canonical_domain: resolved.canonical_domain,
        agent_card_url: resolved.agent_card_url,
        ...(resolved.ucp_profile_url !== undefined
          ? { ucp_profile_url: resolved.ucp_profile_url }
          : {}),
        relationship_type: "preferred",
        scope: {
          catalog_agent_id: resolved.catalog_agent_id,
          ...(options.scope !== undefined ? { procurement_scope: options.scope } : {}),
        },
        ...(options.expires !== undefined
          ? { expires_at: parseExpiresDays(options.expires) }
          : {}),
        consent_source: "human_explicit",
      }),
    );
  } finally {
    db.close();
  }
}

/** `kiwi buyer supplier list`。 */
export async function supplierList(options: SupplierCommandOptions): Promise<SupplierSummary[]> {
  const { db, store } = openSupplierStore(options);
  try {
    return store.listRelationships().map(summarize);
  } finally {
    db.close();
  }
}

export interface SupplierIdOptions extends SupplierCommandOptions {
  relationshipId: string;
}

/** `kiwi buyer supplier pause <relationship-id>`。 */
export async function supplierPause(options: SupplierIdOptions): Promise<SupplierSummary> {
  const { db, store } = openSupplierStore(options);
  try {
    return summarize(store.updateStatus(options.relationshipId, "paused"));
  } finally {
    db.close();
  }
}

/**
 * `kiwi buyer supplier remove <relationship-id>`：软删——立即停止后续拉取并
 * 清除未来调度（§11）。M3 之前 receipt_status 恒为 none，无需远端 revoke；
 * 若将来存在有效 receipt，先 best-effort revoke 但远端不可达不阻塞本地删除。
 */
export async function supplierRemove(options: SupplierIdOptions): Promise<SupplierSummary> {
  const { db, store } = openSupplierStore(options);
  try {
    const rel = store.getRelationship(options.relationshipId);
    if (rel === undefined) {
      throw new Error(`没有供应商关系 ${options.relationshipId}`);
    }
    if (rel.receipt_status !== "none") {
      // M3 预留：当前版本不会进入该分支（无 receipt 发送面）。
      throw new Error(
        `关系 ${options.relationshipId} 存在有效 relationship receipt（${rel.receipt_status}），` +
          "当前版本请先等待 receipt 过期后再删除",
      );
    }
    return summarize(store.updateStatus(options.relationshipId, "deleted"));
  } finally {
    db.close();
  }
}
