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
 * 微信远程控制通道（iLink Bot API）——协议 DTO、错误分类与时序配置。
 *
 * 协议学习自 Hermes Agent 的 weixin adapter（gateway/platforms/weixin.py）：
 * 腾讯 iLink Bot API（个人微信 bot 身份）。模块语义：
 * - 错误统一 `WeixinError`（code 分类，fail-closed 决策点）；
 * - 所有 DTO 只声明我们消费的字段（wire 容忍服务端前向扩展）；
 * - 时序全部可注入覆盖（测试用），生产缺省对齐 Hermes 行为。
 */

/** iLink 服务默认 base URL（与 Hermes ILINK_BASE_URL 一致）。 */
export const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** iLink 协议错误分类（Hermes 归约；分类逻辑集中在客户端 request()）。 */
export type WeixinErrorCode =
  | "network" // fetch 抛错（DNS/连接被拒）
  | "timeout" // AbortController 超时（含长轮询超时）
  | "http" // 非 2xx
  | "redirect" // 3xx（isRedirectResponse）
  | "response_too_large"
  | "invalid_json"
  | "protocol" // 响应 JSON 合法但 ret/errcode 非 0（一般性）
  | "auth" // bot_token 无效（凭证被拒）
  | "session_stale" // -14，或 -2 且 errmsg=="unknown error"
  | "qr_expired"
  | "validation" // DTO 形状不符（fail-closed）
  | "not_configured"; // 无凭证 / 配置类

/** 微信通道错误（fail-closed：任何协议/校验异常抛此类型，不静默容错）。 */
export class WeixinError extends Error {
  readonly code: WeixinErrorCode;

  constructor(code: WeixinErrorCode, message: string) {
    super(message);
    this.name = "WeixinError";
    this.code = code;
  }
}

/** confirmed 返回并持久化的 bot 凭证。 */
export interface BotCredentials {
  /** iLink bot 身份 ID。 */
  ilink_bot_id: string;
  /** bot 访问令牌（仅 base_info 中发送，绝不落日志）。 */
  bot_token: string;
  /** confirmed 携带的 baseurl；后续请求全走它（redirect 后可能变更）。 */
  base_url: string;
  /** 扫描者本人微信用户 ID（= 默认授权身份）。 */
  ilink_user_id: string;
  /** 持久化时间（now() 时钟）。 */
  saved_at: string;
}

/** get_bot_qrcode 响应。 */
export interface BotQrcode {
  /** 二维码 hex token（状态轮询用）。 */
  qrcode: string;
  /** 完整可扫 URL（微信扫一扫实际扫描内容）。 */
  qrcode_img_content: string;
}

/** 扫码状态轮询结果（判别联合）。 */
export type QrcodeStatus =
  | { state: "wait" | "scaned" }
  | { state: "scaned_but_redirect"; baseUrl: string }
  | { state: "expired" }
  | { state: "confirmed"; credentials: BotCredentials };

/** getupdates 里的单条入站消息（只提取消费字段；非文本消息 text=""）。 */
export interface InboundMessage {
  /** 消息来源标识（bot 自身视角）。 */
  account: string;
  from_user_id: string;
  message_id: string;
  /** item_list 中 type:1 的 text_item.text；非文本消息为空串。 */
  text: string;
  /** 回执令牌：回复必须回显（(account,user) 缓存）。 */
  context_token: string;
}

export interface GetUpdatesResult {
  messages: InboundMessage[];
  /** 下轮轮询游标（服务端返回，逐轮写穿持久化）。 */
  next_sync_buf: string;
  /** 服务端建议长轮询时长（毫秒；首轮缺省 LONG_POLL_DEFAULT_MS）。 */
  longpoll_timeout_ms: number;
}

export interface SendMessageInput {
  to_user_id: string;
  text: string;
  /** (account,user) 缓存回显；无则不带。 */
  context_token?: string;
}

/**
 * 时序配置（全部可注入覆盖——测试用；生产缺省对齐 Hermes 行为）。
 */
export interface WeixinTimings {
  /** 长轮询 fetch 超时 = server longpoll_timeout + 该余量（毫秒）。 */
  longPollGraceMs: number;
  /** 连续协议错误退避（毫秒）。 */
  protocolBackoffMs: number;
  /** -14 会话过期冷却（毫秒）。 */
  sessionStaleCooldownMs: number;
  /** 网络/HTTP 错误指数退避（毫秒；第 4 次起封顶最后一项）。 */
  httpBackoffMs: readonly [number, number, number, number];
  /** buyer 任务轮询间隔（毫秒；0 = 禁用）。 */
  schedulerTickMs: number;
  /** autopilot 磋商轮询间隔（毫秒；0 = 禁用）。 */
  negotiateTickMs: number;
  /** 去重指纹/context_token 缓存容量。 */
  dedupCap: number;
  /** 二维码轮询间隔（毫秒）。 */
  qrPollMs: number;
  /** 二维码过期刷新上限。 */
  qrRefreshCap: number;
}

/** 生产缺省时序（Hermes weixin.py 常量对齐）。 */
export const DEFAULT_WEIXIN_TIMINGS: WeixinTimings = {
  longPollGraceMs: 20_000,
  protocolBackoffMs: 30_000,
  sessionStaleCooldownMs: 600_000,
  httpBackoffMs: [2_000, 5_000, 15_000, 60_000],
  schedulerTickMs: 60_000,
  negotiateTickMs: 15_000,
  dedupCap: 1_000,
  qrPollMs: 1_000,
  qrRefreshCap: 3,
};
