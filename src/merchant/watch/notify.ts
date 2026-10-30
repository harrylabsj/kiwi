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
 * watch 通知渠道。
 *
 * - 企业微信群机器人 webhook：主通道；只接受 https + 显式主机白名单，
 *   禁止重定向，5s 超时，响应 ≤256 KiB；文本由调用方保证不含私有底价。
 * - 个人微信 iLink：增强通道；主动发送尽量带上最近一次入站 context_token，
 *   无 token 时仍尝试一次，失败由调用方按“通道降级”处理。
 */

import type { BotCredentials } from "../../weixin/types.js";
import type { IlinkClient } from "../../weixin/ilink-client.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const SEND_TIMEOUT_MS = 5_000;

export interface WatchChannel {
  readonly name: string;
  send(text: string): Promise<void>;
}

export class WecomWebhookChannel implements WatchChannel {
  readonly name = "wecom";
  private readonly url: URL;

  constructor(
    webhookUrl: string,
    private readonly options: { allowedHosts?: readonly string[]; fetchImpl?: typeof fetch } = {},
  ) {
    let parsed: URL;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      throw new Error("企业微信 webhook URL 不合法");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("企业微信 webhook 必须是 https");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new Error("企业微信 webhook 不允许 userinfo");
    }
    const allowed = options.allowedHosts ?? ["qyapi.weixin.qq.com"];
    if (!allowed.includes(parsed.hostname)) {
      throw new Error(`企业微信 webhook 主机不在白名单：${parsed.hostname}`);
    }
    this.url = parsed;
  }

  async send(text: string): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      throw new Error("企业微信 webhook 响应过大");
    }
    if (!response.ok) {
      throw new Error(`企业微信 webhook HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("企业微信 webhook 响应不是 JSON");
    }
    const errcode = (parsed as { errcode?: unknown }).errcode;
    if (typeof errcode === "number" && errcode !== 0) {
      throw new Error(`企业微信 webhook errcode ${errcode}`);
    }
  }
}

export class IlinkWatchChannel implements WatchChannel {
  readonly name = "weixin";

  constructor(
    private readonly client: IlinkClient,
    private readonly credentials: BotCredentials,
    private readonly recipients: readonly string[],
    private readonly contextTokenFor: (userId: string) => string | undefined,
  ) {}

  async send(text: string): Promise<void> {
    if (this.recipients.length === 0) {
      throw new Error("个人微信通道没有授权接收人");
    }
    const failures: string[] = [];
    for (const userId of this.recipients) {
      try {
        await this.client.sendMessage(
          {
            to_user_id: userId,
            text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
            ...(this.contextTokenFor(userId) !== undefined
              ? { context_token: this.contextTokenFor(userId) }
              : {}),
          },
          this.credentials,
        );
      } catch (err) {
        failures.push(`${userId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`个人微信发送失败（${failures.length}/${this.recipients.length}）`);
    }
  }
}
