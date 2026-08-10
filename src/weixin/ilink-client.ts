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
 * iLink Bot API 客户端（微信远程控制通道）——腾讯 iLink 协议实现。
 *
 * 协议学习自 Hermes Agent weixin adapter（gateway/platforms/weixin.py）：
 * - 登录：get_bot_qrcode → 轮询 get_qrcode_status → confirmed 得凭证；
 * - 消息：getupdates 长轮询（get_updates_buf 游标）；sendmessage 回显 context_token；
 * - 头：iLink-App-Id: "bot"、iLink-App-ClientVersion: "131584"（=(2<<16)|(2<<8)|0）；
 * - 错误：ret/errcode 非 0 → protocol；-14 或 (-2+"unknown error") → session_stale。
 * 出站纪律全走 safe-http（manual redirect / 超时覆盖 body / 1 MiB 上限）。
 */

import { isRedirectResponse, readJsonBody, SafeHttpError } from "../net/safe-http.js";
import { ILINK_DEFAULT_BASE_URL, WeixinError } from "./types.js";
import type {
  BotCredentials,
  BotQrcode,
  GetUpdatesResult,
  InboundMessage,
  QrcodeStatus,
  SendMessageInput,
} from "./types.js";

/** iLink 端点（相对 base URL）。 */
const EP_GET_UPDATES = "ilink/bot/getupdates";
const EP_SEND_MESSAGE = "ilink/bot/sendmessage";
const EP_GET_BOT_QR = "ilink/bot/get_bot_qrcode";
const EP_GET_QR_STATUS = "ilink/bot/get_qrcode_status";

/** 协议常量（Hermes weixin.py 对齐）。 */
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0); // "131584"
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const ITEM_TEXT = 1;
const LONG_POLL_DEFAULT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const QR_TIMEOUT_MS = 35_000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB（iLink 响应远小于默认 8 MiB）
const SESSION_EXPIRED_ERRCODE = -14;
const RATE_LIMIT_ERRCODE = -2;

export interface IlinkClientOptions {
  /** iLink base URL（confirmed 的 baseurl 或默认）。 */
  baseUrl?: string;
  log?: (line: string) => void;
}

/**
 * iLink 客户端：登录三端点 + 消息收发。所有请求带 iLink 头，响应严格
 * 解析（未知字段忽略，必需字段缺失 fail-closed），错误类型化分类。
 */
export class IlinkClient {
  private baseUrl: string;
  private readonly log?: (line: string) => void;
  /** sendmessage 的 client_id（每进程一个，幂等标识）。 */
  private readonly clientId: string;

  constructor(options: IlinkClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ILINK_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.log = options.log;
    this.clientId = crypto.randomUUID();
  }

  /** scaned_but_redirect 时切换 base URL（进程内生效；持久化由调用方负责）。 */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  get base(): string {
    return this.baseUrl;
  }

  /** GET ilink/bot/get_bot_qrcode?bot_type=3 → 二维码（hex token + 完整可扫 URL）。 */
  async getBotQrcode(): Promise<BotQrcode> {
    const body = (await this.request("GET", `${EP_GET_BOT_QR}?bot_type=3`, {
      timeoutMs: QR_TIMEOUT_MS,
    })) as Record<string, unknown>;
    const qrcode = body.qrcode;
    const qrcodeImgContent = body.qrcode_img_content;
    if (typeof qrcode !== "string" || qrcode === "" || typeof qrcodeImgContent !== "string") {
      throw new WeixinError("validation", "get_bot_qrcode 响应缺少 qrcode/qrcode_img_content");
    }
    return { qrcode, qrcode_img_content: qrcodeImgContent };
  }

  /** GET ilink/bot/get_qrcode_status?qrcode=<hex> → 扫码状态（判别联合）。 */
  async getQrcodeStatus(qrcode: string): Promise<QrcodeStatus> {
    const body = (await this.request("GET", `${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(qrcode)}`, {
      timeoutMs: QR_TIMEOUT_MS,
    })) as Record<string, unknown>;
    const status = String(body.status ?? "");
    if (status === "confirmed") {
      const accountId = body.ilink_bot_id;
      const token = body.bot_token;
      const baseUrl = body.baseurl;
      const userId = body.ilink_user_id;
      if (typeof accountId !== "string" || accountId === "" || typeof token !== "string" || token === "") {
        throw new WeixinError("validation", "get_qrcode_status confirmed 缺少凭证字段");
      }
      const credentials: BotCredentials = {
        ilink_bot_id: accountId,
        bot_token: token,
        base_url: typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : ILINK_DEFAULT_BASE_URL,
        ilink_user_id: typeof userId === "string" ? userId : "",
        saved_at: "",
      };
      return { state: "confirmed", credentials };
    }
    if (status === "scaned_but_redirect") {
      const redirectHost = String(body.redirect_host ?? "");
      if (redirectHost === "") {
        throw new WeixinError("validation", "scaned_but_redirect 缺少 redirect_host");
      }
      return { state: "scaned_but_redirect", baseUrl: `https://${redirectHost}` };
    }
    if (status === "wait" || status === "scaned" || status === "expired") {
      return { state: status };
    }
    throw new WeixinError("validation", `get_qrcode_status 未知状态 "${status}"`);
  }

  /** POST ilink/bot/getupdates（长轮询）→ 消息 + 新游标。 */
  async getUpdates(
    syncBuf: string,
    credentials: BotCredentials,
    signal?: AbortSignal,
  ): Promise<GetUpdatesResult> {
    const body = (await this.request("POST", EP_GET_UPDATES, {
      timeoutMs: LONG_POLL_DEFAULT_MS + 20_000, // 长轮询需覆盖服务端 longpoll
      payload: {
        get_updates_buf: syncBuf,
        base_info: baseInfoOf(credentials),
      },
      ...(signal !== undefined ? { signal } : {}),
    })) as Record<string, unknown>;
    assertOk(body, "getupdates");
    const messages: InboundMessage[] = [];
    for (const raw of Array.isArray(body.msgs) ? body.msgs : []) {
      if (!isRecord(raw)) continue;
      const text = extractText(raw);
      const message = {
        account: String(raw.from_user_id ?? ""),
        from_user_id: String(raw.from_user_id ?? ""),
        message_id: String(raw.message_id ?? ""),
        text,
        context_token: String(raw.context_token ?? ""),
      };
      messages.push(message);
    }
    const nextSyncBuf = String(body.get_updates_buf ?? syncBuf);
    const longpoll = Number(body.longpolling_timeout_ms ?? LONG_POLL_DEFAULT_MS);
    return {
      messages,
      next_sync_buf: nextSyncBuf,
      longpoll_timeout_ms: Number.isFinite(longpoll) && longpoll > 0 ? longpoll : LONG_POLL_DEFAULT_MS,
    };
  }

  /** POST ilink/bot/sendmessage → 回显 context_token（协议要求）。 */
  async sendMessage(input: SendMessageInput, credentials: BotCredentials): Promise<void> {
    const message: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: input.to_user_id,
      client_id: this.clientId,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text: input.text } }],
    };
    if (input.context_token !== undefined && input.context_token !== "") {
      message.context_token = input.context_token;
    }
    const body = (await this.request("POST", EP_SEND_MESSAGE, {
      timeoutMs: API_TIMEOUT_MS,
      payload: { msg: message, base_info: baseInfoOf(credentials) },
    })) as Record<string, unknown>;
    assertOk(body, "sendmessage");
  }

  // ── 内部：统一请求（safe-http 纪律）──────────────────────────────────

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { timeoutMs: number; payload?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    // 审查 P2-M：外部 abort（通道 stop()）转发到内部 controller——长轮询
    // 在飞时 Ctrl+C 不再等满轮询超时（此前 pollAbort 声明后从未赋值，
    // stop() 的 abort 是空操作，进程退出卡 ~55s）。
    const onExternalAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const headers: Record<string, string> = {
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
      };
      const init: Parameters<typeof fetch>[1] = {
        method,
        headers,
        signal: controller.signal,
        redirect: "manual",
      };
      if (options.payload !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(options.payload);
      }
      const response = await fetch(`${this.baseUrl}/${path}`, init);
      if (isRedirectResponse(response)) {
        throw new WeixinError("redirect", `iLink ${path} 重定向被拒绝 (${response.status})`);
      }
      if (!response.ok) {
        throw new WeixinError("http", `iLink ${path} HTTP ${response.status}`);
      }
      try {
        return await readJsonBody(response, { maxBytes: MAX_RESPONSE_BYTES, signal: controller.signal });
      } catch (err) {
        if (err instanceof SafeHttpError) {
          if (err.code === "response_too_large") throw new WeixinError("response_too_large", err.message);
          if (err.code === "invalid_json") throw new WeixinError("invalid_json", err.message);
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof WeixinError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new WeixinError("timeout", `iLink ${path} 超时 (${options.timeoutMs}ms)`);
      }
      throw new WeixinError("network", `iLink ${path} 网络错误: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

/** base_info 身份三件套（getupdates/sendmessage 通用）。 */
function baseInfoOf(credentials: BotCredentials): Record<string, unknown> {
  return {
    ilink_bot_id: credentials.ilink_bot_id,
    bot_token: credentials.bot_token,
    ilink_user_id: credentials.ilink_user_id,
  };
}

/** 解析 ret/errcode（-14 / -2+"unknown error" → session_stale；其余 → protocol）。 */
function assertOk(body: Record<string, unknown>, endpoint: string): void {
  const ret = body.ret;
  const errcode = body.errcode;
  if (ret === undefined && errcode === undefined) return;
  const retNum = Number(ret ?? 0);
  const errNum = Number(errcode ?? 0);
  if (retNum === 0 && errNum === 0) return;
  if (retNum === SESSION_EXPIRED_ERRCODE || errNum === SESSION_EXPIRED_ERRCODE) {
    throw new WeixinError("session_stale", `${endpoint}: 会话过期 (ret=${ret}, errcode=${errcode})`);
  }
  if (
    (retNum === RATE_LIMIT_ERRCODE || errNum === RATE_LIMIT_ERRCODE) &&
    String(body.errmsg ?? "").toLowerCase() === "unknown error"
  ) {
    throw new WeixinError("session_stale", `${endpoint}: 会话过期 (ret=-2 unknown error)`);
  }
  throw new WeixinError("protocol", `${endpoint}: ret=${ret} errcode=${errcode} errmsg=${String(body.errmsg ?? "")}`);
}

/** 从 item_list 提取文本（type:1 的 text_item.text；非文本消息返回空串）。 */
function extractText(raw: Record<string, unknown>): string {
  const items = raw.item_list;
  if (!Array.isArray(items)) return "";
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === ITEM_TEXT) {
      const textItem = item.text_item;
      if (isRecord(textItem) && typeof textItem.text === "string") return textItem.text;
    }
  }
  return "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
