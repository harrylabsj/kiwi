/* Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { assertResolvableTargetUrl, assertSafeTargetUrl } from "../a2a/client/url-policy.js";
import type { A2aSigningIdentity } from "../a2a/signing-key.js";
import { HttpMessageSigner } from "../trust/identity/index.js";
import { ALIPAY_PRIVATE_PATH, type AlipayCollectionReadBinding } from "../cloud/alipay-collection-http.js";

interface PrivateDetails {
  recipient: string;
  account?: string;
  qrPngBase64?: string;
  totalMinor: number;
  expiresAt: string;
  currency: "CNY";
  version: string;
}

export type NativeAlipayReader = (input: {
  origin: string;
  binding: AlipayCollectionReadBinding;
  totalMinor: number;
  expiresAt: string;
}) => Promise<void>;

export function createNativeAlipayReader(identity: A2aSigningIdentity): NativeAlipayReader {
  return async ({ origin, binding, totalMinor, expiresAt }) => {
    const url = assertSafeTargetUrl(`${origin}${ALIPAY_PRIVATE_PATH}`, {});
    if (url.origin !== origin || url.protocol !== "https:") throw new Error("collection_unavailable");
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify(binding), "utf8");
    const headers = { "content-type": "application/json", accept: "application/json" };
    const signed = new HttpMessageSigner({
      keyid: identity.keyid, algorithm: identity.algorithm, privateKey: identity.privateKeyPem,
      created: now, expires: now + 20, nonce: randomBytes(16).toString("hex"),
    }).sign({ url: url.href, method: "POST", body, headers });
    await assertResolvableTargetUrl(url, {});
    const res = await fetch(url, {
      method: "POST", body, headers: { ...headers, ...signed }, redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!res.ok || res.body === null || !res.headers.get("content-type")?.startsWith("application/json")) {
      await res.body?.cancel();
      throw new Error("collection_unavailable");
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > 768 * 1024) throw new Error("collection_unavailable");
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const details = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as PrivateDetails | null;
    if (details === null || typeof details !== "object" || details.version !== binding.version ||
        details.totalMinor !== totalMinor || details.currency !== "CNY" || Date.parse(details.expiresAt) !== Date.parse(expiresAt) ||
        !(Date.parse(expiresAt) > Date.now()) || typeof details.recipient !== "string" || details.recipient.length > 128 ||
        (details.account !== undefined && (typeof details.account !== "string" || details.account.length > 160)) ||
        (details.qrPngBase64 !== undefined && (typeof details.qrPngBase64 !== "string" ||
          !/^[a-zA-Z0-9+/]+={0,2}$/.test(details.qrPngBase64))) ||
        (details.account === undefined && details.qrPngBase64 === undefined)) throw new Error("collection_unavailable");
    await openPrivateAlipayView(details);
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? ""));
}

/** 仅由显式 TUI 命令调用；内存中一次性本地页面，不把资料写入会话或文件。 */
export async function openPrivateAlipayView(details: PrivateDetails, launch = launchLocalBrowser): Promise<void> {
  const token = randomBytes(24).toString("base64url");
  const lifetime = Math.min(30_000, Date.parse(details.expiresAt) - Date.now());
  if (!(lifetime > 0)) throw new Error("collection_unavailable");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Kiwi 支付宝收款</title><h1>支付宝收款指引</h1><p>收款方：${escapeHtml(details.recipient)}</p><p>应付总额：¥${Math.floor(details.totalMinor / 100)}.${String(details.totalMinor % 100).padStart(2, "0")}（CNY）</p>${details.account === undefined ? "" : `<p>支付宝账号：<code>${escapeHtml(details.account)}</code></p>`}${details.qrPngBase64 === undefined ? "" : `<img width="260" alt="商家提供的支付宝收款码" src="data:image/png;base64,${escapeHtml(details.qrPngBase64)}">`}<p>请在支付宝核对收款人及金额后自行付款。Kiwi 不确认到账；有疑问请联系商家。</p></html>`;
  let authority = "";
  let available = true;
  const deadline = Date.now() + lifetime;
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    if (!available || Date.now() >= deadline || req.method !== "GET" || req.headers.host !== authority || req.url !== `/${token}`) {
      res.writeHead(404, { "cache-control": "no-store", connection: "close" });
      res.end();
      return;
    }
    available = false;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close",
      "content-security-policy": "default-src 'none'; img-src data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    });
    res.end(html);
    close();
  });
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  const timer = setTimeout(close, lifetime);
  timer.unref();
  server.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("collection_unavailable");
    authority = `127.0.0.1:${addr.port}`;
    await launch(`http://${authority}/${token}`);
  } catch {
    close();
    throw new Error("collection_unavailable");
  }
}

export function canOpenPrivateAlipayView(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

function launchLocalBrowser(url: string): Promise<void> {
  const program = process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open";
  return new Promise((resolve, reject) => {
    execFile(program, [url], { timeout: 5000 }, (err) => err === null ? resolve() : reject(new Error("collection_unavailable")));
  });
}
