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
 * 买卖两端向 Catalog 上报各自的意向证据（买家识别与交易回执 · K5/K6/K7）。
 *
 * 事件词表与字段约束与 kiwi-catalog `handlers/commerce_receipts.py` 的
 * 服务端白名单一一对应；投递走持久 outbox：
 *
 * - 商家：持久化协议后记录“协议已签发”；带入口的报价正式发出后记录
 *   “商家已提供入口”；渠道订单创建后记录“订单已创建”（K7）。
 * - 买方：核对 merchant_agreement 并成功提交本地协议后记录“协议已接受
 *   并提交”；实际生成 handoff_ref 后记录“买方已生成交接记录”。
 *
 * 两侧记录与业务提交绑定（同函数内先提交业务事实再入队），重启后以
 * 同一 event ID 补报（Catalog 按“已验证报告方 + 事件 ID”幂等）。拒绝、
 * 待审批和纯本地候选不入队。回执服务故障不阻塞本地流程——投递失败
 * 保留 PENDING 并按退避重试。
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const RECEIPT_PROTOCOL_VERSION = "1.0";

export type ReceiptEventType =
  | "merchant_agreement_issued"
  | "buyer_agreement_accepted"
  | "merchant_entry_offered"
  | "buyer_handoff_generated"
  | "merchant_order_created";

export interface CommerceReceiptBase {
  event_id: string;
  event_type: ReceiptEventType;
  merchant_id: string;
  occurred_at: string;
}

/** 意向回执（六元组字段；商家侧另绑定该次已验签买方凭据）。 */
export interface IntentReceipt extends Omit<CommerceReceiptBase, "event_type"> {
  event_type: "merchant_agreement_issued" | "buyer_agreement_accepted";
  negotiation_id: string;
  merchant_agreement_id: string;
  accepted_offer_id: string;
  terms_digest: string;
  buyer_binding: string;
}

/** 入口回执（无需上传真实跳转 URL；报价引用含磋商号、报价号与摘要）。 */
export interface EntryReceipt extends Omit<CommerceReceiptBase, "event_type"> {
  event_type: "merchant_entry_offered" | "buyer_handoff_generated";
  entry_type: "quote_handoff" | "handoff_record";
  quote_ref: { negotiation_id: string; offer_id: string; terms_digest?: string };
  handoff_ref?: string;
}

/** 订单回执（来源渠道、渠道内稳定订单引用、可验证关联）。 */
export interface OrderReceipt extends Omit<CommerceReceiptBase, "event_type"> {
  event_type: "merchant_order_created";
  order_channel: string;
  order_ref: string;
  order_evidence: {
    merchant_agreement_ref?: string;
    checkout_session_ref?: string;
    channel_evidence?: string;
  };
}

export type CommerceReceipt = IntentReceipt | EntryReceipt | OrderReceipt;

// ---------------------------------------------------------------------------
// 持久投递队列（merchant / buyer 共用；独立 sqlite 文件，重启补报）
// ---------------------------------------------------------------------------

interface OutboxRow {
  event_id: string;
  payload_json: string;
  status: "PENDING" | "DELIVERED";
  attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
}

export interface ReceiptOutboxOptions {
  /** 独立 sqlite 文件绝对路径（商家 a2a dir / 买方数据目录各一份）。 */
  dbPath?: string;
  db?: DatabaseSync;
  reporterScope?: string;
  now: () => string;
}

export class ReceiptOutbox {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly reporterScope: string;

  constructor(options: ReceiptOutboxOptions) {
    this.db = options.db ?? new DatabaseSync(options.dbPath ?? ":memory:");
    this.now = options.now;
    this.reporterScope = options.reporterScope ?? "";
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commerce_receipt_outbox (
        event_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING','DELIVERED')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reporter_scope TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_receipt_outbox_pending
        ON commerce_receipt_outbox (status, next_retry_at);
    `);
    const columns = this.db.prepare("PRAGMA table_info(commerce_receipt_outbox)").all();
    if (!columns.some((column) => column.name === "reporter_scope")) {
      this.db.exec("ALTER TABLE commerce_receipt_outbox ADD COLUMN reporter_scope TEXT NOT NULL DEFAULT ''");
    }
  }

  /**
   * 与业务提交绑定的入队：同一 event_id 幂等（重启补报不重复）。
   * 返回 false 表示同 ID 已存在（内容不同时保留首份——事件 ID 语义不变）。
   */
  enqueue(receipt: CommerceReceipt): boolean {
    const stamp = this.now();
    const payload = JSON.stringify(receipt);
    const result = this.db
        .prepare(
          `INSERT INTO commerce_receipt_outbox
            (event_id, payload_json, status, attempts, next_retry_at, last_error, created_at, updated_at, reporter_scope)
           VALUES (?, ?, 'PENDING', 0, ?, NULL, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`,
        )
        .run(receipt.event_id, payload, stamp, stamp, stamp, this.reporterScope);
    return result.changes !== 0;
  }

  /** 到期待投递的回执（PENDING 且退避到期）。 */
  due(): Array<{ event_id: string; receipt: CommerceReceipt }> {
    const stamp = this.now();
    const rows = this.db
      .prepare(
        `SELECT event_id, payload_json, status, attempts, next_retry_at, last_error
          FROM commerce_receipt_outbox
          WHERE reporter_scope = ? AND status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= ?)
          ORDER BY created_at ASC LIMIT 100`,
      )
      .all(this.reporterScope, stamp) as unknown as OutboxRow[];
    return rows.flatMap((row) => {
      try {
        return [{ event_id: row.event_id, receipt: JSON.parse(row.payload_json) as CommerceReceipt }];
      } catch {
        return [];
      }
    });
  }

  /** 记录投递结果；未知事件 ID 忽略（可能已被清理）。 */
  markDelivered(eventId: string): void {
    this.db
      .prepare(
        "UPDATE commerce_receipt_outbox SET status = 'DELIVERED', last_error = NULL, updated_at = ? WHERE event_id = ?",
      )
      .run(this.now(), eventId);
  }

  /** 投递失败：指数退避（30s × 2^n，上限 15 分钟）。 */
  markFailed(eventId: string, error: string): void {
    const row = this.db
      .prepare("SELECT attempts FROM commerce_receipt_outbox WHERE event_id = ?")
      .get(eventId) as { attempts: number } | undefined;
    const attempts = (row?.attempts ?? 0) + 1;
    const backoffMs = Math.min(30_000 * 2 ** (attempts - 1), 15 * 60_000);
    this.db
      .prepare(
        `UPDATE commerce_receipt_outbox
          SET attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ?
          WHERE event_id = ?`,
      )
      .run(attempts, new Date(Date.parse(this.now()) + backoffMs).toISOString(), error.slice(0, 200), this.now(), eventId);
  }

  pendingCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM commerce_receipt_outbox WHERE status = 'PENDING'")
      .get() as { n: number };
    return Number(row.n);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Catalog 回执客户端
// ---------------------------------------------------------------------------

export interface ReceiptSubmitter {
  /** 投递一份回执；失败抛错（由 dispatcher 记退避）。 */
  submit(receipt: CommerceReceipt): Promise<void>;
}

export interface MerchantReceiptSubmitterOptions {
  catalogUrl: string;
  /** 商家在 Catalog 的 Bearer token（商家凭据绑定该店）。 */
  merchantToken: string;
  fetchImpl?: typeof fetch;
}

/** 商家提交器：商家凭据（Authorization Bearer）。 */
export class MerchantReceiptSubmitter implements ReceiptSubmitter {
  private readonly endpoint: string;
  private readonly merchantToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MerchantReceiptSubmitterOptions) {
    this.endpoint = `${options.catalogUrl.replace(/\/$/, "")}/v1/commerce/receipts`;
    this.merchantToken = options.merchantToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(receipt: CommerceReceipt): Promise<void> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.merchantToken}`,
      },
      body: JSON.stringify({ ...receipt, protocol_version: RECEIPT_PROTOCOL_VERSION }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`catalog receipt submit failed: HTTP ${response.status}`);
    }
  }
}

export interface BuyerReceiptSubmitterOptions {
  catalogUrl: string;
  /** Ed25519 PEM 密钥对（本次磋商的凭据；与商家看到的已验签身份同钥）。 */
  publicKeyPem: string;
  privateKeyPem: string;
  fetchImpl?: typeof fetch;
}

function b64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7638 OKP thumbprint（与 kiwi-catalog jwk_thumbprint 同口径）。 */
export function okpThumbprint(rawPublicKey: Buffer): string {
  const jwk = { crv: "Ed25519", kty: "OKP", x: b64url(rawPublicKey) };
  const canonical = JSON.stringify(jwk);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * 开放询价会话身份（keyid `kiwi-inquiry-session-v1:<base64url(pubkey)>`）
 * → 公钥 thumbprint。商家与买方对同一把会话钥分别推导，得到相同的
 * buyer_binding 六元组字段（C2 意向合并依赖两侧一致）。
 */
export function thumbprintFromOpenInquiryIdentity(identity: string): string | undefined {
  const prefix = "kiwi-inquiry-session-v1:";
  if (!identity.startsWith(prefix)) return undefined;
  const encoded = identity.slice(prefix.length);
  try {
    const raw = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (raw.length !== 32) return undefined;
    return okpThumbprint(raw);
  } catch {
    return undefined;
  }
}

function rawPublicKeyFromPem(publicKeyPem: string): Buffer {
  const spki = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }) as Buffer;
  return spki.subarray(spki.length - 32);
}

/**
 * 买方提交器：自包含 EdDSA JWS（嵌入 JWK，kid = thumbprint）——自签公钥
 * 由 Catalog 单独标明保障级别（self_signed）。签名覆盖全部回执字段 +
 * issued_at（±300s 时钟偏移内有效）。
 */
export class BuyerReceiptSubmitter implements ReceiptSubmitter {
  private readonly endpoint: string;
  private readonly publicKeyPem: string;
  private readonly privateKeyPem: string;
  readonly buyerBinding: string;
  private readonly thumbprint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BuyerReceiptSubmitterOptions) {
    this.endpoint = `${options.catalogUrl.replace(/\/$/, "")}/v1/commerce/receipts`;
    this.publicKeyPem = options.publicKeyPem;
    this.privateKeyPem = options.privateKeyPem;
    const rawPublic = rawPublicKeyFromPem(options.publicKeyPem);
    this.thumbprint = okpThumbprint(rawPublic);
    this.buyerBinding = this.thumbprint;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 生成全新密钥对（测试/本地引导用）。 */
  static generate(catalogUrl: string): BuyerReceiptSubmitter {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return new BuyerReceiptSubmitter({
      catalogUrl,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    });
  }

  /** 买方凭据绑定（= thumbprint；商家侧记录同一值用于本笔对账）。 */
  bindingForReceipt(): string {
    return this.buyerBinding;
  }

  /** 构造自包含 JWS（供测试与 fetch 注入方复用）。 */
  sign(receipt: CommerceReceipt, issuedAt: string): string {
    const jwk = { kty: "OKP", crv: "Ed25519", x: b64url(rawPublicKeyFromPem(this.publicKeyPem)) };
    const header = { alg: "EdDSA", kid: this.thumbprint };
    const payload = { ...this.wireReceipt(receipt), jwk, key_id: this.thumbprint, issued_at: issuedAt };
    const headerSegment = b64url(Buffer.from(JSON.stringify(header)));
    const payloadSegment = b64url(Buffer.from(JSON.stringify(payload)));
    const signature = ed25519Sign(
      null,
      Buffer.from(`${headerSegment}.${payloadSegment}`),
      createPrivateKey(this.privateKeyPem),
    );
    return `${headerSegment}.${payloadSegment}.${b64url(Buffer.from(signature))}`;
  }

  private wireReceipt(receipt: CommerceReceipt): Record<string, unknown> {
    const body: Record<string, unknown> = { ...receipt, protocol_version: RECEIPT_PROTOCOL_VERSION };
    delete body.buyer_binding;
    return body;
  }

  async submit(receipt: CommerceReceipt): Promise<void> {
    const body = {
      ...this.wireReceipt(receipt),
      buyer_signature: this.sign(receipt, new Date().toISOString()),
    };
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`catalog receipt submit failed: HTTP ${response.status}`);
    }
  }
}
