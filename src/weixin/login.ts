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
 * 微信扫码登录流程（iLink Bot API）——取码 → 渲染 QR → 轮询状态 →
 * confirmed 落盘凭证。expired 自动刷新（≤3 次）；scaned_but_redirect
 * 切换 base URL。登录成功后向配对用户发一条"通道就绪"提示（协议上
 * 首次主动消息可能不可达——用户先发一句任意消息即"唤醒"）。
 */

import { renderQr } from "./qr.js";
import { DEFAULT_WEIXIN_TIMINGS, WeixinError } from "./types.js";
import type { BotCredentials } from "./types.js";
import type { IlinkClient } from "./ilink-client.js";

export interface LoginOptions {
  /** 二维码渲染输出（缺省打印到 stdout）。 */
  render?: (qr: string[]) => void;
  /** 提示行输出（缺省 stderr）。 */
  notice?: (line: string) => void;
  /** 扫码轮询间隔（毫秒；缺省 DEFAULT_WEIXIN_TIMINGS.qrPollMs）。 */
  qrPollMs?: number;
  /** 过期刷新上限（缺省 DEFAULT_WEIXIN_TIMINGS.qrRefreshCap）。 */
  qrRefreshCap?: number;
  /** 时间源（测试注入）。 */
  now?: () => string;
}

/**
 * 执行扫码登录并返回凭证（调用方负责持久化）。
 * 失败：网络/协议错抛 WeixinError；多次过期抛 qr_expired。
 */
export async function loginWithQrcode(
  client: IlinkClient,
  options: LoginOptions = {},
): Promise<BotCredentials> {
  const render = options.render ?? ((qr: string[]) => {
    for (const line of qr) process.stdout.write(`${line}\n`);
  });
  const notice = options.notice ?? ((line: string) => process.stderr.write(`${line}\n`));
  const pollMs = options.qrPollMs ?? DEFAULT_WEIXIN_TIMINGS.qrPollMs;
  const refreshCap = options.qrRefreshCap ?? DEFAULT_WEIXIN_TIMINGS.qrRefreshCap;
  const now = options.now ?? (() => new Date().toISOString());

  let refreshCount = 0;
  for (;;) {
    const qrcode = await client.getBotQrcode();
    render(renderQr(qrcode.qrcode_img_content));
    notice("请使用微信扫一扫登录 kiwi 微信通道（8 分钟内有效，过期自动刷新）");

    // 轮询状态直到 confirmed / expired（自动刷新）
    const credentials = await pollUntilConfirmed(client, qrcode.qrcode, {
      pollMs,
      notice,
      onExpired: async (): Promise<boolean> => {
        refreshCount += 1;
        if (refreshCount > refreshCap) {
          throw new WeixinError("qr_expired", `二维码多次过期（>${refreshCap} 次），请重新执行 kiwi weixin`);
        }
        notice(`二维码已过期，正在刷新（${refreshCount}/${refreshCap}）…`);
        return true; // 外层 for 循环重新取码
      },
    });
    if (credentials !== null) {
      credentials.saved_at = now();
      notice("微信连接成功，等待消息…（首次请先发一句任意消息唤醒通道）");
      return credentials;
    }
  }
}

/**
 * 轮询扫码状态直到 confirmed；expired 时回调 onExpired（返回 true 重新取码）。
 * 返回 null 表示 expired 且已请求刷新（由调用方重新取码）。
 */
async function pollUntilConfirmed(
  client: IlinkClient,
  qrcodeHex: string,
  options: {
    pollMs: number;
    notice: (line: string) => void;
    onExpired: () => Promise<boolean>;
  },
): Promise<BotCredentials | null> {
  for (;;) {
    const status = await client.getQrcodeStatus(qrcodeHex);
    switch (status.state) {
      case "wait":
        break;
      case "scaned":
        options.notice("已扫码，请在微信上确认登录…");
        break;
      case "scaned_but_redirect": {
        options.notice(`切换服务节点 ${status.baseUrl}`);
        client.setBaseUrl(status.baseUrl);
        break;
      }
      case "expired": {
        const shouldRefresh = await options.onExpired();
        return shouldRefresh ? null : null;
      }
      case "confirmed":
        return status.credentials;
    }
    await sleep(options.pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
