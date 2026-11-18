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
 * 邮件发送适配器（M6-6，Resend HTTP API）。
 *
 * 收件地址不进入冻结 payload；由宿主按绑定解析后传入 `to`。2xx 表示平台
 * 接受（不等于已读），4xx 可证明未发送，5xx/网络错误为 UNKNOWN。
 */

import type { DeliveryChannelAdapter } from "./channel.js";

export interface EmailChannelAdapterOptions {
  readonly api_key: string;
  readonly from: string;
  /** 测试/单收件人验收；生产应从受控地址库解析。 */
  readonly to: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createEmailChannelAdapter(
  options: EmailChannelAdapterOptions,
): DeliveryChannelAdapter {
  const endpoint = options.endpoint ?? "https://api.resend.com/emails";
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async send({ delivery, idempotency_key, timeout_ms }) {
      if (delivery.channel !== "email") {
        return { outcome: "not_sent", reason: "channel_mismatch" };
      }
      const subject = typeof delivery.payload.title === "string" ? delivery.payload.title : "通知";
      const body = typeof delivery.payload.body === "string" ? delivery.payload.body : "";
      if (body.trim() === "") return { outcome: "not_sent", reason: "payload_empty" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout_ms);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.api_key}`,
            "content-type": "application/json",
            "idempotency-key": idempotency_key,
          },
          body: JSON.stringify({
            from: options.from,
            to: [options.to],
            subject,
            text: body,
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        let receipt: Record<string, unknown> = {};
        try {
          receipt = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
        } catch {
          receipt = { raw: text.slice(0, 500) };
        }
        if (response.status >= 200 && response.status < 300) {
          return {
            outcome: "accepted",
            ...(typeof receipt.id === "string" ? { provider_request_id: receipt.id } : {}),
            receipt,
          };
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          return { outcome: "not_sent", reason: `http_${response.status}` };
        }
        return { outcome: "unknown", receipt: { status: response.status, ...receipt } };
      } catch {
        return { outcome: "unknown" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
