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
 * 店主个人微信 ops bot（独立于 `kiwi weixin` 聊天通道）。
 *
 * 单消费者：独立凭证 + 独立 get_updates_buf，绝不能与聊天通道共用 bot，
 * 否则两个 poller 会互相偷消息。命令只服务扫码者本人与显式 allowlist。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../../fs/atomic-write.js";
import { IlinkClient } from "../../weixin/ilink-client.js";
import { loginWithQrcode } from "../../weixin/login.js";
import {
  loadCredentials,
  loadSyncState,
  saveCredentials,
  saveSyncState,
} from "../../weixin/credentials.js";
import { ILINK_DEFAULT_BASE_URL, WeixinError, type BotCredentials, type InboundMessage } from "../../weixin/types.js";
import type { NegotiationOps } from "../negotiation-ops.js";
import { money } from "./detect.js";
import { IlinkWatchChannel, type WatchChannel } from "./notify.js";

const MAX_REPLY = 2000;
const SEEN_LIMIT = 500;

export interface WeixinOpsPaths {
  credentials: string;
  sync: string;
  context: string;
}

export function weixinOpsPaths(dataDir: string): WeixinOpsPaths {
  return {
    credentials: path.join(dataDir, "weixin-ops-credentials.json"),
    sync: path.join(dataDir, "weixin-ops-sync-buf.json"),
    context: path.join(dataDir, "weixin-ops-context.json"),
  };
}

function loadContexts(file: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { tokens?: Record<string, string> };
    return parsed.tokens ?? {};
  } catch {
    return {};
  }
}

function saveContexts(file: string, tokens: Record<string, string>): void {
  writeFileAtomic(file, `${JSON.stringify({ tokens }, null, 2)}\n`, { mode: 0o600 });
}

export interface WeixinOpsBotOptions {
  dataDir: string;
  allowUsers?: readonly string[];
  forceRelogin?: boolean;
  apiBaseUrl?: string;
  noQr?: boolean;
  log?: (line: string) => void;
}

export class WeixinOpsBot {
  private readonly client: IlinkClient;
  private readonly paths: WeixinOpsPaths;
  private readonly allowUsers: ReadonlySet<string>;
  private readonly log: (line: string) => void;
  private credentials: BotCredentials;
  private syncBuf = "";
  private seen = new Set<string>();
  private contexts: Record<string, string> = {};
  private stopped = false;

  private constructor(
    options: WeixinOpsBotOptions,
    credentials: BotCredentials,
  ) {
    this.client = new IlinkClient({ baseUrl: credentials.base_url || options.apiBaseUrl || ILINK_DEFAULT_BASE_URL });
    this.paths = weixinOpsPaths(options.dataDir);
    this.allowUsers = new Set(options.allowUsers ?? []);
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.credentials = credentials;
  }

  static async open(options: WeixinOpsBotOptions): Promise<WeixinOpsBot> {
    const paths = weixinOpsPaths(options.dataDir);
    let credentials: BotCredentials;
    if (options.forceRelogin || !existsSync(paths.credentials)) {
      const client = new IlinkClient({ baseUrl: options.apiBaseUrl ?? ILINK_DEFAULT_BASE_URL });
      credentials = await loginWithQrcode(client, {
        ...(options.noQr
          ? {
              render: (qr: string[]) => {
                for (const line of qr) process.stdout.write(`${line}\n`);
              },
            }
          : {}),
      });
      saveCredentials(paths.credentials, credentials);
    } else {
      credentials = loadCredentials(paths.credentials);
    }
    const bot = new WeixinOpsBot(options, credentials);
    const sync = loadSyncState(paths.sync);
    bot.syncBuf = sync.get_updates_buf;
    for (const fingerprint of sync.seen) bot.seen.add(fingerprint);
    bot.contexts = loadContexts(paths.context);
    return bot;
  }

  credentialsRef(): BotCredentials {
    return this.credentials;
  }

  recipients(): string[] {
    const paired = this.credentials.ilink_user_id;
    return Array.from(new Set([paired, ...this.allowUsers].filter((id) => id !== "")));
  }

  channel(): WatchChannel {
    return new IlinkWatchChannel(
      this.client,
      this.credentials,
      this.recipients(),
      (userId) => this.contexts[userId],
    );
  }

  async send(text: string): Promise<void> {
    await this.channel().send(text);
  }

  stop(): void {
    this.stopped = true;
  }

  /** 长轮询 + 命令处理；返回 false 表示凭证失效需重新扫码。 */
  async run(service: NegotiationOps): Promise<boolean> {
    let failures = 0;
    while (!this.stopped) {
      try {
        const result = await this.client.getUpdates(this.syncBuf, this.credentials);
        failures = 0;
        for (const message of result.messages) {
          await this.process(message, service);
          if (this.stopped) break;
        }
        this.syncBuf = result.next_sync_buf;
        saveSyncState(this.paths.sync, { get_updates_buf: this.syncBuf, seen: [...this.seen] });
      } catch (err) {
        if (this.stopped) return true;
        if (err instanceof WeixinError && err.code === "auth") {
          this.log(`[watch] 微信凭证被拒：${err.message}。请重新执行 kiwi merchant watch login`);
          return false;
        }
        if (err instanceof WeixinError && err.code === "session_stale") {
          this.log("[watch] 微信会话过期；请重新扫码（kiwi merchant watch login --relogin）");
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          continue;
        }
        failures += 1;
        const backoff = failures >= 5 ? 60_000 : failures >= 3 ? 15_000 : 2_000;
        this.log(`[watch] 微信轮询失败（${failures}）：${err instanceof Error ? err.message : String(err)}；${backoff / 1000}s 后重试`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    return true;
  }

  private async process(message: InboundMessage, service: NegotiationOps): Promise<void> {
    if (message.text.trim() === "") return;
    const fingerprint = createHash("md5").update(`${message.message_id}:${message.text}`).digest("hex");
    if (this.seen.has(fingerprint)) return;
    this.seen.add(fingerprint);
    while (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    const authorized =
      message.from_user_id === this.credentials.ilink_user_id || this.allowUsers.has(message.from_user_id);
    if (!authorized) {
      this.log(`[watch] 忽略未授权微信用户 ${message.from_user_id.slice(0, 12)}…`);
      return;
    }
    if (message.context_token !== "") {
      this.contexts[message.from_user_id] = message.context_token;
      saveContexts(this.paths.context, this.contexts);
    }
    const reply = await this.handleCommand(message.text.trim(), message.from_user_id, service);
    if (reply !== "") {
      try {
        await this.client.sendMessage(
          {
            to_user_id: message.from_user_id,
            text: reply.length > MAX_REPLY ? `${reply.slice(0, MAX_REPLY)}…` : reply,
            ...(this.contexts[message.from_user_id] !== undefined
              ? { context_token: this.contexts[message.from_user_id] }
              : {}),
          },
          this.credentials,
        );
      } catch (err) {
        this.log(`[watch] 微信回复失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async handleCommand(
    text: string,
    fromUser: string,
    service: NegotiationOps,
  ): Promise<string> {
    if (!text.startsWith("/")) return "";
    const [command, ...rest] = text.split(/\s+/);
    try {
      switch (command) {
        case "/help":
          return [
            "可用命令：",
            "/neg — 最近进行中的磋商",
            "/neg <id前缀> — 查看时间线",
            "/approve <审批ID> <单价元> — 批准还价（不得低于底价）",
            "/reject <审批ID> [原因] — 拒绝还价",
            "/status — 通道状态",
          ].join("\n");
        case "/status": {
          const pending = service.listApprovals("pending");
          return `Kiwi ops bot 在线；待审批 ${pending.length} 笔。`;
        }
        case "/neg": {
          if (rest.length === 0) {
            const list = service.listNegotiations({ status: "active", limit: 8 });
            if (list.items.length === 0) return "当前没有进行中的磋商。";
            return list.items
              .map(
                (row) =>
                  `${row.negotiation_id.slice(0, 24)} ${row.sku}${row.quantity !== undefined ? `×${row.quantity}` : ""} ${row.phase}${row.needs_attention ? " ⚠待回应" : ""}`,
              )
              .join("\n");
          }
          const prefix = rest[0]!;
          const all = service.listNegotiations({ status: "all", limit: 100 }).items;
          const match = all.filter((row) => row.negotiation_id.startsWith(prefix));
          if (match.length === 0) return "未找到该磋商。";
          if (match.length > 1) return "前缀匹配到多场磋商，请给更长的 ID。";
          const detail = service.negotiationDetail(match[0]!.negotiation_id);
          return detail.timeline
            .slice(-10)
            .map((entry) => {
              const who = entry.direction === "buyer" ? "买家" : entry.direction === "merchant" ? "商家" : "状态";
              const amount = entry.unit_price_minor !== undefined
                ? ` ${money(entry.currency ?? "CNY", entry.unit_price_minor)}`
                : "";
              return `${entry.at} ${who} ${entry.action}${amount}${entry.public_message !== undefined ? `：${entry.public_message}` : ""}`;
            })
            .join("\n");
        }
        case "/approve": {
          const approvalId = rest[0];
          const price = Number(rest[1]);
          if (approvalId === undefined || !Number.isFinite(price) || price < 0) {
            return "用法：/approve <审批ID> <单价元>";
          }
          const record = service.approve({
            approval_id: approvalId,
            approved_minor: Math.round(price * 100),
            actor: `weixin:${fromUser}`,
          });
          return `已批准 ${record.approval_id}；批准价 ${money(record.currency, record.approved_minor ?? 0)}。买家再次还价时生效。`;
        }
        case "/reject": {
          const approvalId = rest[0];
          if (approvalId === undefined) return "用法：/reject <审批ID> [原因]";
          const reason = rest.slice(1).join(" ").trim();
          const record = service.reject({
            approval_id: approvalId,
            ...(reason !== "" ? { reason } : {}),
            actor: `weixin:${fromUser}`,
          });
          return `已拒绝 ${record.approval_id}。`;
        }
        default:
          return "未知命令，发送 /help 查看用法。";
      }
    } catch (err) {
      if (err instanceof Error && "code" in err) {
        return `操作失败：${err.message}`;
      }
      throw err;
    }
  }
}
