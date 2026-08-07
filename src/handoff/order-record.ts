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
 * Kiwi v0.7.0 Transaction Handoff — OrderRecord（WP3，只读订单事实）。
 *
 * ⚠️ Kiwi 不是订单系统。订单由 merchant 侧创建（business 是 Merchant of Record）；
 * Kiwi 只保存来自 completed checkout 的只读订单事实，用于审计与溯源。Kiwi 永不
 * 实现取消订单 / 退款 / 修改订单路径；支付凭据永远不经过 Kiwi。
 *
 * 本模块：
 *   - OrderRecord：类型层面不可变（全部 readonly，数组也只读）；
 *   - OrderRecordStore：只暴露只读查询 + close，没有任何写操作接口
 *     （ingestOrderRecord 是模块级函数，通过模块私有 symbol 访问内部写入）；
 *   - ingestOrderRecord：从 completed checkout 的 order 字段摄取——order
 *     id / permalink_url / line_items / status / terms_digest，并溯源到
 *     产生它的 agreement / session。
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  requireDigest,
  requireInteger,
  requireIsoTimestamp,
  requireNonEmptyString,
  requireObject,
  schemaError,
} from "../negotiation/domain/common.js";
import { validateIdentifier } from "../negotiation/domain/identifiers.js";

// ---------------------------------------------------------------------------
// 类型（类型层面不可变）
// ---------------------------------------------------------------------------

/** 订单行项目（只读）。 */
export interface OrderRecordLineItem {
  readonly sku: string;
  readonly quantity: number;
  readonly unit_price?: Readonly<{ currency: string; amount_minor: number }>;
}

/** Kiwi 保存的只读订单事实。全部字段 readonly —— 类型层面不可变。 */
export interface OrderRecord {
  /** merchant 侧订单 id（opaque）。 */
  readonly order_id: string;
  /** 订单详情页 URL（merchant 权威）。 */
  readonly permalink_url: string;
  readonly line_items: readonly OrderRecordLineItem[];
  /** merchant 侧订单状态（如 confirmed / fulfilled；Kiwi 不解释，只保存）。 */
  readonly status: string;
  /** 该订单履约的商业 terms 摘要（溯源：与 agreement/session 一致）。 */
  readonly terms_digest: string;
  readonly currency?: string;
  readonly total_minor?: number;
  /** 溯源：产生该订单的 agreement。 */
  readonly agreement_id: string;
  /** 溯源：产生该订单的 negotiation。 */
  readonly negotiation_id: string;
  /** 溯源：产生该订单的 checkout session。 */
  readonly session_ref: string;
  readonly recorded_at: string;
}

/** 摄取输入：completed checkout 的 order 字段 + 溯源上下文。 */
export interface OrderRecordSource {
  order_id: string;
  permalink_url: string;
  line_items: readonly OrderRecordLineItem[];
  status: string;
  terms_digest: string;
  currency?: string;
  total_minor?: number;
  agreement_id: string;
  negotiation_id: string;
  session_ref: string;
  /** 可注入记录时间（RFC 3339）；缺省 now。 */
  recorded_at?: string;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 非负整数（金额/数量语义，与核心 validateMoney 一致——负数不可入审计账）。 */
function requireNonNegativeInteger(value: unknown, path: string): number {
  const n = requireInteger(value, path);
  if (n < 0) {
    throw schemaError(path, `${path} must be a non-negative integer`);
  }
  return n;
}

function validateLineItem(value: unknown, index: number): OrderRecordLineItem {
  const obj = requireObject(value, `line_items/${index}`);
  const base: OrderRecordLineItem = {
    sku: requireNonEmptyString(obj.sku, `line_items/${index}/sku`),
    quantity: requireNonNegativeInteger(obj.quantity, `line_items/${index}/quantity`),
  };
  if (obj.unit_price === undefined) return base;
  const price = requireObject(obj.unit_price, `line_items/${index}/unit_price`);
  return {
    ...base,
    unit_price: {
      currency: requireNonEmptyString(price.currency, `line_items/${index}/unit_price/currency`),
      amount_minor: requireNonNegativeInteger(
        price.amount_minor,
        `line_items/${index}/unit_price/amount_minor`,
      ),
    },
  };
}

function validateSource(source: OrderRecordSource): OrderRecordSource {
  if (!/^https?:\/\/\S+$/.test(source.permalink_url)) {
    throw schemaError("permalink_url", "permalink_url must be an http(s) URL");
  }
  return {
    ...source,
    order_id: validateIdentifier(source.order_id, "order_id"),
    permalink_url: requireNonEmptyString(source.permalink_url, "permalink_url"),
    line_items: source.line_items.map((item, i) => validateLineItem(item, i)),
    status: requireNonEmptyString(source.status, "status"),
    terms_digest: requireDigest(source.terms_digest, "terms_digest"),
    ...(source.currency !== undefined
      ? { currency: requireNonEmptyString(source.currency, "currency") }
      : {}),
    ...(source.total_minor !== undefined
      ? { total_minor: requireNonNegativeInteger(source.total_minor, "total_minor") }
      : {}),
    agreement_id: validateIdentifier(source.agreement_id, "agreement_id"),
    negotiation_id: validateIdentifier(source.negotiation_id, "negotiation_id"),
    session_ref: validateIdentifier(source.session_ref, "session_ref"),
    ...(source.recorded_at !== undefined
      ? { recorded_at: requireIsoTimestamp(source.recorded_at, "recorded_at") }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

/** 本地存储：目录 0700 / 数据库文件 0600（对齐 agent 数据布局）。 */
export interface OrderRecordStoreOptions {
  dbPath: string;
  /** 可注入时钟（RFC 3339）；缺省 new Date().toISOString()。 */
  now?: () => string;
}

const ORDER_SCHEMA = `
CREATE TABLE IF NOT EXISTS order_records (
  order_id       TEXT PRIMARY KEY,
  permalink_url  TEXT NOT NULL,
  line_items     TEXT NOT NULL,
  status         TEXT NOT NULL,
  terms_digest   TEXT NOT NULL,
  currency       TEXT,
  total_minor    INTEGER,
  agreement_id   TEXT NOT NULL,
  negotiation_id TEXT NOT NULL,
  session_ref    TEXT NOT NULL,
  recorded_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_terms_digest ON order_records(terms_digest);
CREATE INDEX IF NOT EXISTS idx_order_agreement_id ON order_records(agreement_id);
`;

interface OrderRow {
  order_id: string;
  permalink_url: string;
  line_items: string;
  status: string;
  terms_digest: string;
  currency: string | null;
  total_minor: number | null;
  agreement_id: string;
  negotiation_id: string;
  session_ref: string;
  recorded_at: string;
}

/** 模块私有 symbol：让 ingestOrderRecord（模块函数）访问内部写入，外部不可达。 */
const INGEST = Symbol("order-record.ingest");
/** 模块私有构造 token：外部无法构造 OrderRecordStore，只能经 openOrderRecordStore。 */
const STORE_CTOR = Symbol("order-record.ctor");

/**
 * 只读订单事实查询面。公开方法只有 get / list / findByTermsDigest /
 * findByAgreement / count / close —— 没有任何写操作接口。
 */
export class OrderRecordStore {
  private readonly db: DatabaseSync;

  /**
   * 构造需要模块私有的 token（`STORE_CTOR` 未导出），外部无法凭空构造；
   * 只能经 openOrderRecordStore 创建。
   */
  constructor(db: DatabaseSync, _token: typeof STORE_CTOR) {
    this.db = db;
  }

  /** 按 merchant order_id 查询。 */
  get(orderId: string): OrderRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM order_records WHERE order_id = ?")
      .get(orderId) as unknown as OrderRow | undefined;
    return row === undefined ? undefined : this.rowToRecord(row);
  }

  /** 全部订单事实（按记录时间升序）。 */
  list(): readonly OrderRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM order_records ORDER BY recorded_at, order_id")
      .all() as unknown as OrderRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /** 按 terms_digest 溯源查询（审计「哪些订单履约同一组 terms」）。 */
  findByTermsDigest(termsDigest: string): readonly OrderRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM order_records WHERE terms_digest = ? ORDER BY recorded_at")
      .all(termsDigest) as unknown as OrderRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /** 按 agreement 溯源查询。 */
  findByAgreement(agreementId: string): readonly OrderRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM order_records WHERE agreement_id = ? ORDER BY recorded_at")
      .all(agreementId) as unknown as OrderRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /** 已保存订单事实数量。 */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM order_records").get() as {
      n: number;
    };
    return row.n;
  }

  close(): void {
    this.db.close();
  }

  private rowToRecord(row: OrderRow): OrderRecord {
    return {
      order_id: row.order_id,
      permalink_url: row.permalink_url,
      line_items: JSON.parse(row.line_items) as OrderRecordLineItem[],
      status: row.status,
      terms_digest: row.terms_digest,
      ...(row.currency !== null ? { currency: row.currency } : {}),
      ...(row.total_minor !== null ? { total_minor: row.total_minor } : {}),
      agreement_id: row.agreement_id,
      negotiation_id: row.negotiation_id,
      session_ref: row.session_ref,
      recorded_at: row.recorded_at,
    };
  }

  // 内部写入：只允许本模块的 ingestOrderRecord 调用（symbol 未导出）。
  [INGEST](source: OrderRecordSource, recordedAt: string): OrderRecord {
    const record: OrderRecord = {
      order_id: source.order_id,
      permalink_url: source.permalink_url,
      line_items: source.line_items.map((item) => ({ ...item })),
      status: source.status,
      terms_digest: source.terms_digest,
      ...(source.currency !== undefined ? { currency: source.currency } : {}),
      ...(source.total_minor !== undefined ? { total_minor: source.total_minor } : {}),
      agreement_id: source.agreement_id,
      negotiation_id: source.negotiation_id,
      session_ref: source.session_ref,
      recorded_at: recordedAt,
    };
    this.db
      .prepare(
        `INSERT INTO order_records
           (order_id, permalink_url, line_items, status, terms_digest, currency,
            total_minor, agreement_id, negotiation_id, session_ref, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET
           permalink_url=excluded.permalink_url,
           line_items=excluded.line_items,
           status=excluded.status,
           terms_digest=excluded.terms_digest,
           currency=excluded.currency,
           total_minor=excluded.total_minor,
           agreement_id=excluded.agreement_id,
           negotiation_id=excluded.negotiation_id,
           session_ref=excluded.session_ref,
           recorded_at=excluded.recorded_at`,
      )
      .run(
        record.order_id,
        record.permalink_url,
        JSON.stringify(record.line_items),
        record.status,
        record.terms_digest,
        record.currency ?? null,
        record.total_minor ?? null,
        record.agreement_id,
        record.negotiation_id,
        record.session_ref,
        record.recorded_at,
      );
    return this.get(record.order_id) as OrderRecord;
  }
}

/** 打开（必要时创建）本地订单事实存储；目录 0700 / 文件 0600。 */
export function openOrderRecordStore(options: OrderRecordStoreOptions): OrderRecordStore {
  if (options.dbPath === ":memory:") {
    const db = new DatabaseSync(":memory:");
    db.exec(ORDER_SCHEMA);
    return new OrderRecordStore(db, STORE_CTOR);
  }
  const dir = path.dirname(options.dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const db = new DatabaseSync(options.dbPath);
  if (existsSync(options.dbPath)) chmodSync(options.dbPath, 0o600);
  db.exec(ORDER_SCHEMA);
  return new OrderRecordStore(db, STORE_CTOR);
}

/**
 * 从 completed checkout 的 order 字段摄取一条只读订单事实。这是唯一的写入路径；
 * 之后只能通过只读查询读取。
 */
export function ingestOrderRecord(
  store: OrderRecordStore,
  source: OrderRecordSource,
  now: () => string = () => new Date().toISOString(),
): OrderRecord {
  const validated = validateSource(source);
  const recordedAt = validated.recorded_at ?? now();
  requireIsoTimestamp(recordedAt, "recorded_at");
  return store[INGEST](validated, recordedAt);
}
