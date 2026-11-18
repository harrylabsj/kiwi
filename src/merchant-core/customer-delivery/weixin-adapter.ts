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
 * 微信 iLink 发送适配器（M6-6）。
 *
 * iLink `sendmessage` 没有业务幂等键：成功只表示平台接受；超时/网络错误
 * 视为 UNKNOWN，不能凭猜测重发。调用方必须先用绑定/订阅确认收件人。
 */

import type { DeliveryChannelAdapter } from "./channel.js";
import type { SendMessageInput } from "../../weixin/types.js";
import type { BotCredentials } from "../../weixin/types.js";

export interface WeixinSender {
  sendMessage(input: SendMessageInput, credentials: BotCredentials): Promise<void>;
}

export interface WeixinChannelAdapterOptions {
  readonly sender: WeixinSender;
  readonly credentials: BotCredentials;
  /** 测试收件人：默认使用 bot 扫码者本人（ilink_user_id）。 */
  readonly recipient_user_id?: string;
  readonly max_text_chars?: number;
}

export function createWeixinChannelAdapter(
  options: WeixinChannelAdapterOptions,
): DeliveryChannelAdapter {
  const maxChars = options.max_text_chars ?? 2000;
  return {
    async send({ delivery }) {
      if (delivery.channel !== "wechat") {
        return { outcome: "not_sent", reason: "channel_mismatch" };
      }
      const to = options.recipient_user_id ?? options.credentials.ilink_user_id;
      if (typeof to !== "string" || to.trim() === "") {
        return { outcome: "not_sent", reason: "recipient_missing" };
      }
      const title = typeof delivery.payload.title === "string" ? delivery.payload.title : "";
      const body = typeof delivery.payload.body === "string" ? delivery.payload.body : "";
      const text = [title, body].filter((part) => part.trim() !== "").join("\n").slice(0, maxChars);
      if (text === "") return { outcome: "not_sent", reason: "payload_empty" };
      try {
        await options.sender.sendMessage({ to_user_id: to, text }, options.credentials);
        // iLink 成功响应只证明平台接受，不等于客户已读。
        return { outcome: "accepted", receipt: { channel: "weixin", accepted: true } };
      } catch {
        return { outcome: "unknown" };
      }
    },
  };
}
