/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inImmediateTransaction } from "../storage/transaction.js";

export interface AlipayCollectionConfig {
  version: string;
  enabled: boolean;
  recipient: string;
  account?: string;
  qrPngBase64?: string;
}

export const ALIPAY_QR_MAX_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const PNG_MAX_SIDE = 1024;

/** Bounded structural check only: no decompression, CRC, QR decoding or Alipay verification. */
export function isBoundedAlipayQrPng(value: unknown): value is string {
  if (typeof value !== "string" || value.length > Math.ceil(ALIPAY_QR_MAX_BYTES / 3) * 4) return false;
  const png = Buffer.from(value, "base64");
  if (png.length < 45 || png.length > ALIPAY_QR_MAX_BYTES || png.toString("base64") !== value ||
      !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(8) !== 13 ||
      png.toString("latin1", 12, 16) !== "IHDR") return false;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0 || width > PNG_MAX_SIDE || height > PNG_MAX_SIDE) return false;
  let hasData = false;
  for (let offset = 33; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) return false;
    const type = png.toString("latin1", offset + 4, offset + 8);
    if (type === "IEND") return hasData && length === 0 && end === png.length;
    if (type === "IHDR" || type === "acTL" || type === "fcTL" || type === "fdAT") return false;
    if (type === "IDAT" && length > 0) hasData = true;
    offset = end;
  }
  return false;
}

export class AlipayCollectionConflict extends Error {
  constructor() {
    super("支付宝收款配置版本已变化，请刷新后重新预览");
  }
}

/** Tenant-local data. Raw values never belong in management projections or logs. */
export class AlipayCollectionStore {
  constructor(private readonly db: DatabaseSync, readonly merchantId: string) {
    inImmediateTransaction(db, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS alipay_collection_config (
          merchant_id TEXT PRIMARY KEY NOT NULL,
          version TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          recipient TEXT NOT NULL,
          account TEXT,
          qr_png_base64 TEXT
        );
        CREATE TABLE IF NOT EXISTS alipay_collection_audit (
          version TEXT PRIMARY KEY NOT NULL,
          merchant_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
        );
        CREATE TABLE IF NOT EXISTS alipay_collection_audit_changes (
          version TEXT PRIMARY KEY NOT NULL REFERENCES alipay_collection_audit(version),
          recipient_changed INTEGER NOT NULL CHECK (recipient_changed IN (0, 1)),
          account_changed INTEGER NOT NULL CHECK (account_changed IN (0, 1)),
          qr_changed INTEGER NOT NULL CHECK (qr_changed IN (0, 1)),
          initial INTEGER CHECK (initial IN (0, 1))
        );
      `);
      // Preserve historical flags; NULL means this version predates the explicit marker.
      const columns = db.prepare("PRAGMA table_info(alipay_collection_audit_changes)").all();
      if (!columns.some((column) => column.name === "initial")) {
        db.exec("ALTER TABLE alipay_collection_audit_changes ADD COLUMN initial INTEGER CHECK (initial IN (0, 1))");
      }
    });
  }

  current(): AlipayCollectionConfig | undefined {
    const row = this.db.prepare(`
      SELECT version, enabled, recipient, account, qr_png_base64
      FROM alipay_collection_config WHERE merchant_id = ?
    `).get(this.merchantId) as {
      version: string;
      enabled: number;
      recipient: string;
      account: string | null;
      qr_png_base64: string | null;
    } | undefined;
    if (row === undefined) return undefined;
    return {
      version: row.version,
      enabled: row.enabled === 1,
      recipient: row.recipient,
      ...(row.account === null ? {} : { account: row.account }),
      ...(row.qr_png_base64 === null ? {} : { qrPngBase64: row.qr_png_base64 }),
    };
  }

  replace(
    expectedVersion: string | null,
    input: Omit<AlipayCollectionConfig, "version">,
    actorId: string,
    changedAt: string,
  ): AlipayCollectionConfig {
    return inImmediateTransaction(this.db, () => {
      const previous = this.current();
      if ((previous?.version ?? null) !== expectedVersion) throw new AlipayCollectionConflict();
      const config = { ...input, version: randomUUID() };
      this.db.prepare(`
        INSERT INTO alipay_collection_config (merchant_id, version, enabled, recipient, account, qr_png_base64)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (merchant_id) DO UPDATE SET version = excluded.version, enabled = excluded.enabled,
          recipient = excluded.recipient, account = excluded.account, qr_png_base64 = excluded.qr_png_base64
      `).run(this.merchantId, config.version, Number(config.enabled), config.recipient,
        config.account ?? null, config.qrPngBase64 ?? null);
      this.db.prepare(`
        INSERT INTO alipay_collection_audit (version, merchant_id, actor_id, changed_at, enabled)
        VALUES (?, ?, ?, ?, ?)
      `).run(config.version, this.merchantId, actorId, changedAt, Number(config.enabled));
      // The initial marker distinguishes field presence at setup from changes to an existing config.
      // Never record values or hashes of low-entropy account identifiers.
      this.db.prepare(`
        INSERT INTO alipay_collection_audit_changes (version, recipient_changed, account_changed, qr_changed, initial)
        VALUES (?, ?, ?, ?, ?)
      `).run(config.version, Number(previous?.recipient !== config.recipient),
        Number(previous?.account !== config.account), Number(previous?.qrPngBase64 !== config.qrPngBase64), Number(previous === undefined));
      return config;
    });
  }
}
