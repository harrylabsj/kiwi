/* Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudRequestListener } from "./http-router.js";
import { DEFAULT_COVERED_COMPONENTS, parseSignatureInput } from "../trust/identity/index.js";

export const ALIPAY_PRIVATE_PATH = "/buyer/v1/collection/alipay";
export const ALIPAY_LANDING_PREFIX = "/collect/alipay/";

const PRIVATE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

export interface AlipayCollectionReadBinding {
  negotiationId: string;
  offerId: string;
  version: string;
  agreementId: string;
  termsDigest: string;
}

export interface AlipayCollectionQuote {
  version: string;
  totalMinor: number;
  currency: "CNY";
  expiresAt: string;
}

const MAX_SIGNATURE_INPUT_BYTES = 2048;

/** 读敏感资料时要求单个完整签名与随机 nonce；身份、签名及重放仍由 A2A verifier 验证。 */
export function hasAlipayReadSignature(signatureInput: unknown): boolean {
  if (typeof signatureInput !== "string" || signatureInput.length > MAX_SIGNATURE_INPUT_BYTES) return false;
  try {
    const [entry, ...rest] = parseSignatureInput(signatureInput);
    return entry !== undefined && rest.length === 0 && /^[a-f0-9]{32}$/.test(entry.params.nonce ?? "") &&
      DEFAULT_COVERED_COMPONENTS.every((component) => entry.components.includes(component));
  } catch { return false; }
}

interface Options {
  merchantId: string;
  verifyBuyer: (req: IncomingMessage, body: Buffer) => Promise<{ merchantId: string; buyerPrincipalId: string } | undefined>;
  lookup: (input: AlipayCollectionReadBinding & { buyerPrincipalId: string }) => AlipayCollectionQuote | undefined;
  current: () => { version: string; enabled: boolean; recipient: string; account?: string; qrPngBase64?: string } | undefined;
  now?: () => number;
}

function json(res: ServerResponse, status: number, value: object): void {
  res.writeHead(status, { ...PRIVATE_HEADERS, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function bindingFrom(raw: Buffer): AlipayCollectionReadBinding | undefined {
  try {
    const input = JSON.parse(raw.toString("utf8")) as Partial<AlipayCollectionReadBinding> | null;
    if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 5) return;
    const { negotiationId, offerId, version, agreementId, termsDigest } = input;
    const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
    if (!id(negotiationId) || !id(offerId) || !id(version) || !id(agreementId) ||
        typeof termsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(termsDigest)) return;
    return { negotiationId, offerId, version, agreementId, termsDigest };
  } catch { return undefined; }
}

async function readBinding(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Do not destroy the connection on iterator early exit: return a bounded error.
  for await (const value of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    size += chunk.length;
    if (size > 2048) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** 公开地址仅供安全探测；完整收款资料仅从验签 API 返回。 */
export function createAlipayCollectionHttp(options: Options): { landing: CloudRequestListener; privateDetails: CloudRequestListener } {
  const landing: CloudRequestListener = (req, res) => {
    if (req.method !== "HEAD" && req.method !== "GET") {
      res.writeHead(405, { ...PRIVATE_HEADERS, allow: "GET, HEAD" });
      res.end();
      return;
    }
    res.writeHead(200, { ...PRIVATE_HEADERS, "content-type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : "<!doctype html><html lang=zh-CN><meta charset=utf-8><title>Kiwi 支付宝收款</title><p>如已确认交接，请回到 Kiwi 买家端查看收款指引。本页不收款，也不确认到账。</p></html>");
  };
  const privateDetails: CloudRequestListener = (req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== ALIPAY_PRIVATE_PATH) {
        json(res, 404, { error: "collection_unavailable" });
        return;
      }
      const raw = await readBinding(req);
      const binding = raw === undefined ? undefined : bindingFrom(raw);
      if (raw === undefined || binding === undefined) {
        json(res, 400, { error: "invalid_collection_request" });
        return;
      }
      const buyer = await options.verifyBuyer(req, raw);
      const quote = buyer?.merchantId === options.merchantId
        ? options.lookup({ ...binding, buyerPrincipalId: buyer.buyerPrincipalId }) : undefined;
      const config = quote === undefined ? undefined : options.current();
      if (quote === undefined || config?.enabled !== true || config.version !== binding.version || quote.version !== config.version ||
          !(Date.parse(quote.expiresAt) > (options.now ?? Date.now)())) {
        json(res, 404, { error: "collection_unavailable" });
        return;
      }
      json(res, 200, { ...quote, recipient: config.recipient,
        ...(config.account === undefined ? {} : { account: config.account }),
        ...(config.qrPngBase64 === undefined ? {} : { qrPngBase64: config.qrPngBase64 }),
      });
    })().catch(() => {
      if (!res.headersSent) json(res, 404, { error: "collection_unavailable" });
      else res.destroy();
    });
  };
  return { landing, privateDetails };
}
