/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type ServerOptions } from "node:https";
import { TLSSocket } from "node:tls";
import { ManualSupportError, type ManualSupportService } from "../merchant-core/support/manual-service.js";

const API = "/api/customer-service/v1";
const COOKIE = "__Host-kiwi_cs";
const DAY_SECONDS = 86_400;
const MAX_BODY_BYTES = 8192;
const MAX_NEW_SESSIONS_PER_WINDOW = 10;
const WINDOW_MS = 10 * 60_000;
const CASE_PATH = /^\/sessions\/current\/cases\/(CS-[0-9a-f-]{36})$/;

const STATUS = {
  validation: [400, "检查输入后重试。"], unauthorized: [401, "原会话不可继续，请重新建立会话或通过商家人工渠道联系。"],
  forbidden: [403, "请求未获授权。"], not_found: [404, "未找到资源。"], conflict: [409, "提交与原请求不一致或状态已变化。"],
  capacity: [429, "暂时不能继续提交，请稍后重试。"], unavailable: [503, "暂时无法确认操作结果，请用同一请求重试。"],
} as const;

function single(req: IncomingMessage, name: string): string | undefined {
  const values = req.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

function token(req: IncomingMessage): string | undefined {
  const matches = (req.headers.cookie ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE}=`));
  if (matches.length > 1) throw new ManualSupportError("validation");
  return matches[0]?.slice(COOKIE.length + 1);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (single(req, "content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ManualSupportError("validation");
  const chunks: Buffer[] = [];
  let bytes = 0;
  // 使用 iterator 的非销毁模式，让有界拒绝可以返回 400，而不替客户端接受半个 JSON。
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const value = Buffer.from(chunk as Buffer);
    bytes += value.length;
    if (bytes > MAX_BODY_BYTES) { req.resume(); throw new ManualSupportError("validation"); }
    chunks.push(value);
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const value: unknown = JSON.parse(decoded);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ManualSupportError("validation"); }
}

const SCRIPT = String.raw`
const api = '/api/customer-service/v1';
const messages = document.getElementById('messages');
const note = document.getElementById('note');
const originalNote = note.textContent;
const form = document.getElementById('intake');
const send = document.getElementById('submit');
const retry = document.getElementById('retry');
const older = document.getElementById('older');
const resume = document.getElementById('resume');
const description = document.getElementById('description');
const skuField = document.getElementById('sku');
let pending, cursor, before, timer, established = false, busy = false, generation = 0, delay = 3000;
const statusText = {case_receipt:'已登记，等待商家领取。', claimed:'人工已领取。', human_reply:'商家回复', resolved:'商家标记本工单已解决'};
async function call(path, payload) {
  const options = {credentials:'same-origin',cache:'no-store'};
  if (payload !== undefined) Object.assign(options,{method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload)});
  const r = await fetch(api + path, options);
  const data = await r.json();
  if (!r.ok) throw {status:r.status, message:data.message};
  return data;
}
function unavailable(error, hadCursor = false) {
  note.textContent = error.message || '连接中断，未确认处理结果。';
  if (error.status === 401 || (hadCursor && error.status === 400)) {
    // 另一标签页可能重建了 Cookie，旧游标不能用来继续显示原会话。
    if (error.status === 400) note.textContent = '无法确认当前浏览器仍在原会话，请重新连接或联系商家。';
    generation++; established=false; pending=undefined; cursor=undefined; before=undefined;
    messages.textContent=''; description.value=''; skuField.value=''; form.hidden=true; older.hidden=true;
    retry.hidden=true; resume.hidden=false;
    clearTimeout(timer);
  }
}
function display(items, prepend) {
  const fragment = document.createDocumentFragment();
  for (const event of items) {
    const li = document.createElement('li');
    li.textContent = event.case_id + ' · ' + statusText[event.kind] + (event.text ? '：' + event.text : '');
    fragment.appendChild(li);
  }
  if (prepend) messages.prepend(fragment); else messages.appendChild(fragment);
}
async function update() {
  clearTimeout(timer);
  if (!established || document.hidden || busy) return;
  const currentGeneration = generation;
  const previousCursor = cursor;
  busy = true;
  try {
    const data = await call('/sessions/current/updates'+(previousCursor ? '?after='+encodeURIComponent(previousCursor) : ''));
    if (generation !== currentGeneration) return;
    if (!previousCursor) { messages.textContent=''; before=data.previous_cursor; older.hidden=!before; }
    display(data.events, false); cursor=data.next_cursor;
    delay = data.events.length ? 3000 : Math.min(30000, delay*2);
  } catch (e) {
    if (generation === currentGeneration) { unavailable(e, !!previousCursor); delay = Math.min(30000, delay*2); }
  }
  finally {
    busy=false;
    if (established && !document.hidden) timer=setTimeout(update,delay);
  }
}
async function start() {
  resume.disabled = true;
  try {
    const result = await call('/sessions',{});
    established=true; form.hidden=false; resume.hidden=true;
    note.textContent = result.reset ? '原会话已失效，已开始新会话。如需跟进原工单，请联系商家。' : originalNote;
    cursor=undefined; generation++; delay=3000; update();
  } catch(e) { unavailable(e); resume.hidden=false; } finally { resume.disabled=false; }
}
async function submit() {
  if (!pending || !established || send.disabled) return;
  const currentGeneration = generation;
  send.disabled=true; retry.disabled=true;
  try {
    await call('/sessions/current/messages',pending);
    if (generation !== currentGeneration) return;
    pending=undefined; description.value=''; skuField.value=''; note.textContent='售后请求已登记，等待商家处理。';
    delay=3000; update();
  } catch(e) {
    if (generation !== currentGeneration) return;
    unavailable(e);
    if (e.status === 400 || e.status === 409) pending=undefined;
  } finally { send.disabled=false; retry.disabled=false; retry.hidden=!pending; }
}
form.onsubmit = (event) => {
  event.preventDefault();
  if (pending) { note.textContent='上一条尚未确认，请先重试原请求。'; return; }
  pending={type:'confirm_case',client_message_id:crypto.randomUUID(),description:description.value};
  const sku=skuField.value.trim(); if (sku) pending.sku=sku;
  void submit();
};
retry.onclick=submit;
older.onclick=async () => {
  if (!before) return;
  older.disabled=true; const currentGeneration=generation;
  try {
    const data=await call('/sessions/current/updates?before='+encodeURIComponent(before));
    if (generation!==currentGeneration) return;
    display(data.events,true); before=data.previous_cursor; older.hidden=!before;
  } catch(e) { if (generation === currentGeneration) unavailable(e, true); } finally { older.disabled=false; }
};
resume.onclick=start;
document.addEventListener('visibilitychange',() => { if (document.hidden) clearTimeout(timer); else update(); });
void start();`;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

function page(nonce: string, serviceHours: string, contactHint: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>商家售后</title><main><h1>商家售后</h1><p>服务时段：${escapeHtml(serviceHours)}。人工联系：${escapeHtml(contactHint)}。</p>
    <p>此处只登记售后，不验证订单或执行退款。不要填写付款凭据、地址或完整联系方式。请用当前浏览器回来查看回复。</p>
    <p id="note" role="status">等待商家领取，不承诺处理时限。</p><button id="resume" type="button" hidden>开始新会话</button>
    <form id="intake" hidden><p><label>SKU（可选） <input id="sku" maxlength="64"></label></p>
    <p><label>问题描述 <textarea id="description" maxlength="2000" required></textarea></label></p>
    <button id="submit" type="submit">提交售后</button><button id="retry" type="button" hidden>重试原请求</button></form>
    <h2>我的工单更新</h2><button id="older" type="button" hidden>查看更早记录</button><ol id="messages"></ol></main>
    <script nonce="${nonce}">${SCRIPT}</script></html>`;
}

/** 只提供独立的买家 HTTPS 页面/API；不受理 Workbench、A2A 或代理身份请求。 */
export function createManualSupportBuyerHandler(options: {
  service: ManualSupportService; origin: string; serviceHours: string; contactHint: string;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.origin !== options.origin || !options.serviceHours.trim() || !options.contactHint.trim()) {
    throw new ManualSupportError("validation");
  }
  const end = new Map<string, number>();
  const count = new Map<string, number>();
  function limit(peer: string): void {
    const now = Date.now();
    for (const [key, expiry] of end) if (expiry <= now) { end.delete(key); count.delete(key); }
    if (!end.has(peer)) {
      if (end.size >= 1000) throw new ManualSupportError("capacity");
      end.set(peer, now + WINDOW_MS);
    }
    const used = count.get(peer) ?? 0;
    if (used >= MAX_NEW_SESSIONS_PER_WINDOW) throw new ManualSupportError("capacity");
    count.set(peer, used + 1);
  }
  function json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted || single(req, "host") !== origin.host) throw new ManualSupportError("forbidden");
    const raw = req.url ?? "";
    if (raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) throw new ManualSupportError("validation");
    const path = new URL(raw, origin);
    if (req.method === "GET" && path.pathname === "/" && path.search === "") {
      const nonce = randomBytes(24).toString("base64");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
      res.end(page(nonce, options.serviceHours, options.contactHint));
      return;
    }
    if (!path.pathname.startsWith(`${API}/`)) throw new ManualSupportError("not_found");
    const relative = path.pathname.slice(API.length);
    const access = token(req);
    const peerOrigin = single(req, "origin");
    const fetchSite = single(req, "sec-fetch-site");
    if ((fetchSite !== undefined && fetchSite !== "same-origin") || (peerOrigin !== undefined && peerOrigin !== origin.origin) ||
        (req.method === "POST" && peerOrigin !== origin.origin)) throw new ManualSupportError("forbidden");
    if (req.method === "POST" && path.search === "") {
      if (relative === "/sessions") {
        if (Object.keys(await body(req)).length !== 0) throw new ManualSupportError("validation");
        const opened = options.service.begin(access, () => limit(req.socket.remoteAddress ?? "unknown"));
        if (opened.token !== undefined) res.setHeader("set-cookie", `${COOKIE}=${opened.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${90 * DAY_SECONDS}`);
        json(res, 200, { reset: opened.reset, service_hours: options.serviceHours });
        return;
      }
      if (relative === "/sessions/current/messages") {
        const value = await body(req);
        if (Object.keys(value).some((key) => !["type", "client_message_id", "description", "sku"].includes(key)) ||
            value.type !== "confirm_case" || typeof value.description !== "string" || typeof value.client_message_id !== "string" ||
            (value.sku !== undefined && typeof value.sku !== "string")) throw new ManualSupportError("validation");
        json(res, 202, options.service.confirmCase(access, { client_message_id: value.client_message_id, description: value.description,
          ...(value.sku === undefined ? {} : { sku: value.sku }) }));
        return;
      }
    }
    if (req.method === "GET") {
      if (relative === "/sessions/current/updates") {
        const keys = [...path.searchParams.keys()];
        if (keys.length > 1 || keys.some((key) => key !== "after" && key !== "before")) throw new ManualSupportError("validation");
        const after = path.searchParams.get("after"), before = path.searchParams.get("before");
        json(res, 200, options.service.updates(access, after !== null ? { after } : before !== null ? { before } : {}));
        return;
      }
      const id = CASE_PATH.exec(relative)?.[1];
      if (id !== undefined && path.search === "") { json(res, 200, options.service.ownCase(access, id)); return; }
    }
    throw new ManualSupportError("not_found");
  }
  return (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      const code = error instanceof ManualSupportError ? error.code : "unavailable";
      const [status, message] = STATUS[code];
      if (status === 429) res.setHeader("retry-after", "600");
      json(res, status, { error: code, message });
    });
  };
}

export interface ManualSupportPreviewOptions {
  tls: Pick<ServerOptions, "key" | "cert">;
  serviceHours: string;
  contactHint: string;
}

/** 只为本地验收开启；独立 hostname，使 host-only Cookie 不进入 127.0.0.1 工作台。 */
export async function startLocalManualSupportBuyer(service: ManualSupportService, options: ManualSupportPreviewOptions) {
  if (!options.tls.key || !options.tls.cert || !options.serviceHours.trim() || !options.contactHint.trim()) throw new ManualSupportError("validation");
  let handle: ReturnType<typeof createManualSupportBuyerHandler>;
  const server = createServer({ ...options.tls, requestTimeout: 10_000, headersTimeout: 10_000 }, (req, res) => handle(req, res));
  const origin = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") { server.close(); reject(new ManualSupportError("unavailable")); return; }
      const value = `https://localhost:${address.port}`;
      handle = createManualSupportBuyerHandler({ origin: value, service, serviceHours: options.serviceHours, contactHint: options.contactHint });
      resolve(value);
    });
  });
  return { origin, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
