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
 * 商家侧运营统计（merchant stats）——本地买家触达事实。
 *
 * 数据来源唯一：merchant 自己的 A2A 入站管线（InboundPipeline）在
 * `message_received` 落账成功后写入一条 buyer_contact_events。数据只落
 * 商家本地 DB（<dataDir>/a2a/stats.sqlite），永不上报任何远端。
 *
 * 语义：
 *   - 主键 message_id（INSERT OR IGNORE）：与协议幂等（§20）对齐，
 *     同一消息重放不重复计数；
 *   - distinct_buyers 仅在 KIWI_A2A_AUTH=signature 下有真实去重语义——
 *     loopback/none/bearer 模式下 buyer 身份坍缩（loopback 地址、
 *     "anonymous"、静态 token 身份），CLI 输出附带 identity_note 说明；
 *   - 天数一律 UTC（occurred_at ISO 串切前 10 位），与全仓时间处理一致。
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { requireIsoTimestamp, requireNonEmptyString } from "../negotiation/domain/common.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一次买家触达事实（来自入站 KNP envelope，已经过了 schema/digest/幂等校验）。 */
export interface BuyerContactEvent {
  /** envelope.message_id（幂等主键）。 */
  message_id: string;
  /** 传输层认证身份（signature 模式 = 真实买家；其余模式可能坍缩）。 */
  buyer_identity: string;
  negotiation_id: string;
  exchange_id: string;
  /** envelope.action（inquiry/rfq/offer/counter_offer/...）。 */
  action: string;
  /** 从 payload 提取的 SKU（inquiry 等无 SKU 动作为空数组）。 */
  skus: string[];
  /** envelope.created_at（RFC 3339）。 */
  occurred_at: string;
}

/** 窗口总量。 */
export interface ContactTotals {
  distinct_buyers: number;
  contact_events: number;
  negotiations: number;
}

/** 单日聚合（day 为 UTC `YYYY-MM-DD`）。 */
export interface DailyBucket {
  day: string;
  distinct_buyers: number;
  contact_events: number;
  negotiations: number;
}

/** 单日买家身份集合的去重行，用于跨日粒度聚合。 */
export interface DailyBuyerIdentity {
  day: string;
  buyer_identity: string;
}

/** 单 SKU 聚合。 */
export interface SkuStat {
  sku: string;
  contact_events: number;
  distinct_buyers: number;
  negotiations: number;
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

/** 本地存储：目录 0700 / 数据库文件 0600（对齐 agent 数据布局）。 */
export interface MerchantStatsStoreOptions {
  dbPath: string;
}

const STATS_SCHEMA = `
CREATE TABLE IF NOT EXISTS buyer_contact_events (
  message_id      TEXT PRIMARY KEY,
  buyer_identity  TEXT NOT NULL,
  negotiation_id  TEXT NOT NULL,
  exchange_id     TEXT,
  action          TEXT NOT NULL,
  skus_json       TEXT NOT NULL DEFAULT '[]',
  occurred_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buyer_contact_buyer ON buyer_contact_events(buyer_identity);
CREATE INDEX IF NOT EXISTS idx_buyer_contact_time ON buyer_contact_events(occurred_at);
`;

interface TotalsRow {
  distinct_buyers: number;
  contact_events: number;
  negotiations: number;
}

interface DailyRow extends TotalsRow {
  day: string;
}

interface SkuRow {
  sku: string;
  contact_events: number;
  distinct_buyers: number;
  negotiations: number;
}

/** 商家买家触达统计存储。写入面只有 recordBuyerContact；其余为聚合查询。 */
export class MerchantStatsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * 记录一次买家触达（INSERT OR IGNORE：同 message_id 幂等去重——协议层已
   * 保证恰好一次调用，这里是崩溃/重试窗口的兜底）。
   */
  recordBuyerContact(event: BuyerContactEvent): void {
    const messageId = requireNonEmptyString(event.message_id, "message_id");
    const buyerIdentity = requireNonEmptyString(event.buyer_identity, "buyer_identity");
    const negotiationId = requireNonEmptyString(event.negotiation_id, "negotiation_id");
    const action = requireNonEmptyString(event.action, "action");
    const occurredAt = requireIsoTimestamp(event.occurred_at, "occurred_at");
    // SKU 去重（单条事件内同 SKU 重复出现只计一次触达）。
    const skus = [...new Set(event.skus.filter((s) => typeof s === "string" && s !== ""))];
    this.db
      .prepare(
        `INSERT OR IGNORE INTO buyer_contact_events
           (message_id, buyer_identity, negotiation_id, exchange_id, action, skus_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        buyerIdentity,
        negotiationId,
        event.exchange_id === "" ? null : event.exchange_id,
        action,
        JSON.stringify(skus),
        occurredAt,
      );
  }

  /** 窗口总量（sinceDay 含当天，UTC `YYYY-MM-DD`）。 */
  totalsSince(sinceDay: string): ContactTotals {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT buyer_identity) AS distinct_buyers,
                COUNT(*) AS contact_events,
                COUNT(DISTINCT negotiation_id) AS negotiations
         FROM buyer_contact_events
         WHERE substr(occurred_at, 1, 10) >= ?`,
      )
      .get(sinceDay) as unknown as TotalsRow;
    return {
      distinct_buyers: row.distinct_buyers,
      contact_events: row.contact_events,
      negotiations: row.negotiations,
    };
  }

  /** 按日聚合（只返回有数据的天；零填充由调用方做）。 */
  dailySince(sinceDay: string): DailyBucket[] {
    const rows = this.db
      .prepare(
        `SELECT substr(occurred_at, 1, 10) AS day,
                COUNT(DISTINCT buyer_identity) AS distinct_buyers,
                COUNT(*) AS contact_events,
                COUNT(DISTINCT negotiation_id) AS negotiations
         FROM buyer_contact_events
         WHERE substr(occurred_at, 1, 10) >= ?
         GROUP BY day
         ORDER BY day`,
      )
      .all(sinceDay) as unknown as DailyRow[];
    return rows.map((r) => ({
      day: r.day,
      distinct_buyers: r.distinct_buyers,
      contact_events: r.contact_events,
      negotiations: r.negotiations,
    }));
  }

  /** 按日返回原始身份去重行，避免周/月把同一买家跨日重复相加。 */
  dailyBuyerIdentitiesSince(sinceDay: string): DailyBuyerIdentity[] {
    const rows = this.db
      .prepare(
        `SELECT substr(occurred_at, 1, 10) AS day, buyer_identity
         FROM buyer_contact_events
         WHERE substr(occurred_at, 1, 10) >= ?
         GROUP BY day, buyer_identity
         ORDER BY day, buyer_identity`,
      )
      .all(sinceDay) as unknown as DailyBuyerIdentity[];
    return rows.map((row) => ({ day: row.day, buyer_identity: row.buyer_identity }));
  }

  /** SKU 热度榜（按触达事件数降序，sku 升序兜底，截断 limit）。 */
  topSkus(sinceDay: string, limit: number): SkuStat[] {
    const rows = this.db
      .prepare(
        `SELECT je.value AS sku,
                COUNT(*) AS contact_events,
                COUNT(DISTINCT buyer_identity) AS distinct_buyers,
                COUNT(DISTINCT negotiation_id) AS negotiations
         FROM buyer_contact_events,
              json_each(buyer_contact_events.skus_json) AS je
         WHERE substr(occurred_at, 1, 10) >= ?
         GROUP BY je.value
         ORDER BY contact_events DESC, sku ASC
         LIMIT ?`,
      )
      .all(sinceDay, limit) as unknown as SkuRow[];
    return rows.map((r) => ({
      sku: r.sku,
      contact_events: r.contact_events,
      distinct_buyers: r.distinct_buyers,
      negotiations: r.negotiations,
    }));
  }

  close(): void {
    this.db.close();
  }
}

/** 打开（必要时创建）本地统计存储；目录 0700 / 文件 0600。 */
export function openMerchantStatsStore(options: MerchantStatsStoreOptions): MerchantStatsStore {
  if (options.dbPath === ":memory:") {
    const db = new DatabaseSync(":memory:");
    db.exec(STATS_SCHEMA);
    return new MerchantStatsStore(db);
  }
  const dir = path.dirname(options.dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const db = new DatabaseSync(options.dbPath);
  if (existsSync(options.dbPath)) chmodSync(options.dbPath, 0o600);
  db.exec(STATS_SCHEMA);
  return new MerchantStatsStore(db);
}
