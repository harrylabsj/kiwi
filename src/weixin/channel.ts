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
 * 微信远程控制通道——长轮询收消息 → AgentKernel.handleUserText →
 * sendMessage 回显（含 context_token）。白名单 fail-closed、去重、
 * 定时任务（schedulerTick / negotiationAutoTick）转发、优雅关闭。
 *
 * 对齐 runChatTui 语义：每条微信文本 = 一次 handleUserText；/slash 命令
 * 经微信可远程控制（/mode /approve /reject /quit 等）；通知/磋商前缀
 * 转发给所有已授权用户。
 */

import { createHash } from "node:crypto";
import type { AgentKernel } from "../agent/kernel.js";
import { loadCredentials, loadSyncState, saveCredentials, saveSyncState } from "./credentials.js";
import { IlinkClient } from "./ilink-client.js";
import { loginWithQrcode } from "./login.js";
import type { BotCredentials, InboundMessage, WeixinTimings } from "./types.js";
import { DEFAULT_WEIXIN_TIMINGS, WeixinError } from "./types.js";

/** 回复文本上限（微信单条消息长度约束）。 */
const MAX_REPLY_LENGTH = 2000;

/** 单条消息日志长度（不落 context_token/凭证）。 */
const LOG_TEXT_LENGTH = 40;

export interface WeixinChannelOptions {
  kernel: AgentKernel;
  /** iLink base URL（已解析：env > profile > default）。 */
  apiBaseUrl?: string;
  credentialsPath: string;
  syncBufPath: string;
  /** 配置白名单（配对扫描者自动授权；CLI/env/profile 合并后）。 */
  allowUsers?: readonly string[];
  /** 强制重新扫码（丢弃已存凭证）。 */
  forceRelogin?: boolean;
  /** 二维码渲染（缺省 stdout 打印）。 */
  renderQr?: (qr: string[]) => void;
  /** 二维码每模块列数（审查 P3：--qr-scale 传到这里，再进 login）。 */
  qrScale?: number;
  /** 状态行输出（缺省 stderr）。 */
  notice?: (line: string) => void;
  /** 日志行（缺省 stderr；不落 token/context_token）。 */
  log?: (line: string) => void;
  now?: () => string;
  /** 时序覆盖（测试注入冷却/间隔）。 */
  timings?: Partial<WeixinTimings>;
}

export interface WeixinChannelStatus {
  loggedIn: boolean;
  pairedUser: string | undefined;
  allowCount: number;
}

/**
 * 微信通道：open() 登录或加载凭证，run() 阻塞直到 /quit/致命错误/stop()。
 * kernel 生命周期归 CLI 所有（对齐 cmdChat：CLI finally 里 kernel.close()）。
 */
export class WeixinChannel {
  private readonly kernel: AgentKernel;
  private readonly credentialsPath: string;
  private readonly syncBufPath: string;
  private readonly allowUsers: ReadonlySet<string>;
  private readonly timings: WeixinTimings;
  private readonly log: (line: string) => void;
  private readonly now: () => string;

  private client: IlinkClient;
  private credentials: BotCredentials | null = null;
  /** context_token 缓存（key = user_id；协议要求回复回显）。 */
  private readonly contextTokens = new Map<string, string>();
  /** 去重指纹（message_id:text MD5；LRU FIFO 裁剪）。 */
  private readonly seen = new Set<string>();
  private stopped = false;
  private runPromise: Promise<number> | null = null;
  private pollAbort: AbortController | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private noticeFn: (line: string) => void;

  constructor(options: WeixinChannelOptions) {
    this.kernel = options.kernel;
    this.credentialsPath = options.credentialsPath;
    this.syncBufPath = options.syncBufPath;
    this.allowUsers = new Set(options.allowUsers ?? []);
    this.timings = { ...DEFAULT_WEIXIN_TIMINGS, ...options.timings };
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.now = options.now ?? (() => new Date().toISOString());
    this.noticeFn = options.notice ?? ((line) => process.stderr.write(`${line}\n`));
    this.client = new IlinkClient({ baseUrl: options.apiBaseUrl });
  }

  static async open(options: WeixinChannelOptions): Promise<WeixinChannel> {
    const channel = new WeixinChannel(options);
    if (options.forceRelogin) {
      channel.credentials = await channel.loginAndSave(options);
    } else {
      try {
        channel.credentials = loadCredentials(options.credentialsPath);
        // 凭证 base_url 可能为空（首次 confirmed 前未持久化）——缺省用 apiBaseUrl/默认。
        if (channel.credentials.base_url !== "") {
          channel.client.setBaseUrl(channel.credentials.base_url);
        }
        channel.log(`[weixin] 已加载凭证 bot=${channel.credentials.ilink_bot_id}`);
      } catch (err) {
        if (err instanceof WeixinError && err.code === "not_configured") {
          channel.credentials = await channel.loginAndSave(options);
        } else {
          throw err;
        }
      }
    }
    return channel;
  }

  /** 扫码登录并持久化凭证。 */
  private async loginAndSave(options: WeixinChannelOptions): Promise<BotCredentials> {
    const credentials = await loginWithQrcode(this.client, {
      render: options.renderQr,
      notice: options.notice,
      qrPollMs: this.timings.qrPollMs,
      qrRefreshCap: this.timings.qrRefreshCap,
      ...(options.qrScale !== undefined ? { qrScale: options.qrScale } : {}),
      now: this.now,
    });
    saveCredentials(this.credentialsPath, credentials);
    this.client.setBaseUrl(credentials.base_url);
    this.log(`[weixin] 登录成功 bot=${credentials.ilink_bot_id} paired=${credentials.ilink_user_id}`);
    return credentials;
  }

  get status(): WeixinChannelStatus {
    return {
      loggedIn: this.credentials !== null,
      pairedUser: this.credentials?.ilink_user_id || undefined,
      allowCount: this.allowUsers.size,
    };
  }

  /** 阻塞直到 /quit、致命错误或 stop()；返回进程退出码。 */
  async run(): Promise<number> {
    if (this.credentials === null) {
      throw new WeixinError("not_configured", "微信通道未登录");
    }
    this.runPromise = this.runLoop();
    return this.runPromise;
  }

  /** 优雅关闭：置 stopped → abort 在飞长轮询 → 写穿 sync state → 清定时器。 */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.pollAbort?.abort();
    for (const t of this.timers.splice(0)) clearInterval(t);
    if (this.runPromise !== null) {
      try {
        await this.runPromise;
      } catch {
        // stop 后的轮询异常被 stopped 分支吞掉
      }
    }
  }

  // ── 主循环 ──────────────────────────────────────────────────────────

  private async runLoop(): Promise<number> {
    const creds = this.credentials!;
    // 定时任务（对齐 runChatTui：首 tick 立即跑，后续 interval unref）
    await this.schedulerTickOnce();
    this.startTimer(this.timings.schedulerTickMs, () => void this.schedulerTickOnce());
    await this.negotiateOnce();
    this.startTimer(this.timings.negotiateTickMs, () => void this.negotiateOnce());

    // 恢复游标 + 去重指纹
    let syncBuf = "";
    try {
      const state = loadSyncState(this.syncBufPath);
      syncBuf = state.get_updates_buf;
      for (const fp of state.seen) this.seen.add(fp);
    } catch (err) {
      // 审查 P3：损坏的同步状态必须 fail-closed——此前打日志后从头轮询，
      // seen 指纹随同一文件丢失，旧消息（含 /slash 命令）整批重放（命令
      // 二次执行）。缺文件是首次运行（loadSyncState 返回空态），只有损坏
      // 才抛 WeixinError。
      this.log(
        `[weixin] 同步状态损坏，拒绝重扫（修复或删除 ${this.syncBufPath} 后重启）：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return 2; // EXIT.CONFIG
    }

    let consecutiveProtocolErrors = 0;
    let fatalCount = 0;
    // 审查 P2-M：在飞长轮询的 abort 句柄——stop() 的 pollAbort?.abort()
    // 此前是空操作（声明后从未赋值），Ctrl+C 退出被阻塞到轮询超时
    // （~55s）。现在 runLoop 创建 controller 并传入 getUpdates。
    this.pollAbort = new AbortController();
    const pollSignal = this.pollAbort.signal;

    while (!this.stopped) {
      try {
        const result = await this.client.getUpdates(syncBuf, creds, pollSignal);
        consecutiveProtocolErrors = 0;
        fatalCount = 0;
        syncBuf = result.next_sync_buf;
        for (const msg of result.messages) {
          await this.processMessage(msg);
          if (this.stopped) return 0;
        }
        // 每轮写穿游标 + 去重（重启零丢失）
        saveSyncState(this.syncBufPath, { get_updates_buf: syncBuf, seen: [...this.seen] });
      } catch (err) {
        if (this.stopped) return 0;
        if (err instanceof WeixinError) {
          switch (err.code) {
            case "session_stale":
              this.log(`[weixin] 会话过期：${err.message}。${this.timings.sessionStaleCooldownMs / 1000}s 后重试（可 kill 后 kiwi weixin --relogin 重扫）`);
              await this.sleep(this.timings.sessionStaleCooldownMs);
              consecutiveProtocolErrors = 0;
              continue;
            case "protocol":
              consecutiveProtocolErrors++;
              if (consecutiveProtocolErrors >= 3) {
                this.log(`[weixin] 连续协议错误 ${consecutiveProtocolErrors} 次，退避 ${this.timings.protocolBackoffMs / 1000}s`);
                await this.sleep(this.timings.protocolBackoffMs);
                consecutiveProtocolErrors = 0;
              }
              continue;
            case "timeout":
            case "network":
            case "http":
            case "redirect":
            case "response_too_large":
            case "invalid_json": {
              // 指数退避（2s/5s/15s/60s 封顶）
              const backoff = this.timings.httpBackoffMs[Math.min(fatalCount, this.timings.httpBackoffMs.length - 1)]!;
              fatalCount++;
              this.log(`[weixin] ${err.code}：${err.message}。${backoff / 1000}s 后重试`);
              await this.sleep(backoff);
              continue;
            }
            case "auth":
              this.log(`[weixin] 凭证被拒：${err.message}。请 kill 后 kiwi weixin --relogin 重扫`);
              return 3; // EXIT.AUTH
            default:
              fatalCount++;
              if (fatalCount >= 5) {
                this.log(`[weixin] 连续致命错误 ${fatalCount} 次，退出`);
                return 10; // EXIT.TRANSIENT
              }
              this.log(`[weixin] ${err.message}`);
              await this.sleep(2_000);
              continue;
          }
        }
        fatalCount++;
        if (fatalCount >= 5) {
          this.log(`[weixin] 连续致命错误 ${fatalCount} 次，退出`);
          return 10;
        }
        this.log(`[weixin] ${err instanceof Error ? err.message : String(err)}`);
        await this.sleep(2_000);
      }
    }
    if (this.pollAbort?.signal === pollSignal) {
      this.pollAbort = null;
    }
    return 0;
  }

  // ── 消息处理 ────────────────────────────────────────────────────────

  private async processMessage(msg: InboundMessage): Promise<void> {
    if (msg.text === "") {
      this.log(`[weixin] 跳过非文本消息 from=${shortId(msg.from_user_id)}`);
      return;
    }
    // 去重（message_id + 内容指纹）
    const fingerprint = createHash("md5").update(`${msg.message_id}:${msg.text}`).digest("hex");
    if (this.seen.has(fingerprint)) {
      this.log(`[weixin] 去重跳过 from=${shortId(msg.from_user_id)}`);
      return;
    }
    this.seen.add(fingerprint);
    this.trimSeen();

    // 白名单：配对扫描者自动授权 + 配置 allowUsers；未授权不回复（不确认 bot 存在）
    const paired = this.credentials?.ilink_user_id ?? "";
    const authorized = msg.from_user_id === paired || this.allowUsers.has(msg.from_user_id);
    if (!authorized) {
      this.log(`[weixin] 拒绝未授权用户 ${shortId(msg.from_user_id)}（不回复）`);
      return;
    }

    // 缓存 context_token（回复必须回显）
    if (msg.context_token !== "") {
      this.contextTokens.set(msg.from_user_id, msg.context_token);
      this.trimContextTokens();
    }
    const contextToken = this.contextTokens.get(msg.from_user_id);

    this.log(`[weixin] ${shortId(msg.from_user_id)} → ${truncate(msg.text, LOG_TEXT_LENGTH)}`);

    const reply = await this.kernel.handleUserText(msg.text);
    if (reply.text !== "") {
      await this.trySend(msg.from_user_id, reply.text, contextToken);
    }
    if (reply.quit) {
      this.log("[weixin] 收到 /quit，通道退出");
      this.stopped = true;
    }
  }

  /** 发送消息（失败仅日志，不重试——模型回合昂贵，重试只覆盖轮询层）。 */
  private async trySend(toUserId: string, text: string, contextToken?: string): Promise<void> {
    if (this.credentials === null) return;
    const clipped = text.length > MAX_REPLY_LENGTH ? `${text.slice(0, MAX_REPLY_LENGTH)}…（已截断）` : text;
    try {
      await this.client.sendMessage({ to_user_id: toUserId, text: clipped, context_token: contextToken }, this.credentials);
    } catch (err) {
      this.log(`[weixin] 回复发送失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 定时任务（对齐 runChatTui）──────────────────────────────────────

  private async schedulerTickOnce(): Promise<void> {
    if (this.timings.schedulerTickMs === 0) return;
    try {
      const result = await this.kernel.schedulerTick();
      for (const n of result.notifications) {
        await this.broadcast(`[通知] ${n.summary}（任务 ${n.task_id}）`);
      }
      for (const e of result.errors) {
        await this.broadcast(`[任务] ${e}`);
      }
    } catch (err) {
      this.log(`[weixin] schedulerTick 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async negotiateOnce(): Promise<void> {
    if (this.timings.negotiateTickMs === 0) return;
    try {
      const text = await this.kernel.negotiationAutoTick();
      if (text !== undefined && text !== "") {
        await this.broadcast(`[磋商] ${text}`);
      }
    } catch (err) {
      this.log(`[weixin] negotiationAutoTick 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 转发给所有已授权用户（有 context_token 的优先；无 token 的首次可能不可达）。 */
  private async broadcast(text: string): Promise<void> {
    const targets = new Set<string>();
    if (this.credentials !== null && this.credentials.ilink_user_id !== "") {
      targets.add(this.credentials.ilink_user_id);
    }
    for (const u of this.allowUsers) targets.add(u);
    for (const to of targets) {
      await this.trySend(to, text, this.contextTokens.get(to));
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────

  private startTimer(ms: number, fn: () => void): void {
    if (ms === 0) return;
    const t = setInterval(fn, ms);
    t.unref();
    this.timers.push(t);
  }

  private trimSeen(): void {
    while (this.seen.size > this.timings.dedupCap) {
      const first = this.seen.values().next().value as string | undefined;
      if (first === undefined) break;
      this.seen.delete(first);
    }
  }

  private trimContextTokens(): void {
    while (this.contextTokens.size > this.timings.dedupCap) {
      const first = this.contextTokens.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.contextTokens.delete(first);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
