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

import { createInterface } from "node:readline/promises";

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
  /** 二维码每模块列数（审查 P3：此前 CLI --qr-scale 传到这里就断了，
   *  renderQr 恒用默认 scale=1，文档承诺的 --qr-scale 2 静默无效）。 */
  qrScale?: number;
  /** 配对码输入（`need_verifycode` 时手机微信显示的数字；测试注入）。 */
  readVerifyCode?: (prompt: string) => Promise<string>;
  /** 时间源（测试注入）。 */
  now?: () => string;
}

/**
 * 执行扫码登录并返回凭证（调用方负责持久化）。
 * 失败：网络/协议错抛 WeixinError；多次过期或配对码多次错误抛 qr_expired。
 */
export async function loginWithQrcode(
  client: IlinkClient,
  options: LoginOptions = {},
): Promise<BotCredentials> {
  const render = options.render ?? ((qr: string[]) => {
    for (const line of qr) process.stdout.write(`${line}\n`);
  });
  const notice = options.notice ?? ((line: string) => process.stderr.write(`${line}\n`));
  const readVerifyCode = options.readVerifyCode ?? readVerifyCodeFromStdin;
  const pollMs = options.qrPollMs ?? DEFAULT_WEIXIN_TIMINGS.qrPollMs;
  const refreshCap = options.qrRefreshCap ?? DEFAULT_WEIXIN_TIMINGS.qrRefreshCap;
  const now = options.now ?? (() => new Date().toISOString());

  let refreshCount = 0;
  let pendingVerifyCode: string | undefined;
  for (;;) {
    const qrcode = await client.getBotQrcode();
    render(renderQr(qrcode.qrcode_img_content, options.qrScale ?? 1));
    notice("请使用微信扫一扫登录 kiwi 微信通道（8 分钟内有效，过期自动刷新）");

    let scannedNoticeShown = false;
    let refresh = false;
    while (!refresh) {
      const status = await client.getQrcodeStatus(
        qrcode.qrcode,
        pendingVerifyCode === undefined ? {} : { verifyCode: pendingVerifyCode },
      );
      switch (status.state) {
        case "wait":
          break;
        case "scaned":
          if (pendingVerifyCode !== undefined) {
            notice("配对码已通过，请在微信上确认登录…");
            pendingVerifyCode = undefined;
            scannedNoticeShown = true;
          } else if (!scannedNoticeShown) {
            notice("已扫码，请在微信上确认登录…");
            scannedNoticeShown = true;
          }
          break;
        case "scaned_but_redirect": {
          notice(`切换服务节点 ${status.baseUrl}`);
          client.setBaseUrl(status.baseUrl);
          break;
        }
        case "need_verifycode": {
          // 手机微信显示配对数字：输入后立即带 verify_code 重新轮询；
          // 配对码错误时服务端会再次返回 need_verifycode，重新提示输入。
          const code = (
            await readVerifyCode(
              pendingVerifyCode === undefined
                ? "请输入手机微信显示的数字以继续绑定："
                : "配对码不正确，请重新输入手机微信显示的数字：",
            )
          ).trim();
          if (!/^\d{1,12}$/.test(code)) {
            throw new WeixinError("validation", "配对码必须是手机微信显示的数字");
          }
          pendingVerifyCode = code;
          continue;
        }
        case "verify_code_blocked": {
          pendingVerifyCode = undefined;
          refreshCount += 1;
          if (refreshCount > refreshCap) {
            throw new WeixinError("qr_expired", `配对码多次错误（>${refreshCap} 次），请重新执行扫码绑定`);
          }
          notice(`配对码错误次数过多，该二维码已作废，正在刷新（${refreshCount}/${refreshCap}）…`);
          refresh = true;
          break;
        }
        case "binded_redirect": {
          // 该微信号已绑定过本 bot（服务端按 local_token_list 匹配）。
          throw new WeixinError(
            "auth",
            "该微信号已绑定过 Kiwi，无法重复绑定：请在微信中解除原绑定后重试",
          );
        }
        case "expired": {
          pendingVerifyCode = undefined;
          refreshCount += 1;
          if (refreshCount > refreshCap) {
            throw new WeixinError("qr_expired", `二维码多次过期（>${refreshCap} 次），请重新执行扫码绑定`);
          }
          notice(`二维码已过期，正在刷新（${refreshCount}/${refreshCap}）…`);
          refresh = true;
          break;
        }
        case "confirmed": {
          const credentials = status.credentials;
          credentials.saved_at = now();
          notice("微信连接成功，等待消息…（首次请先发一句任意消息唤醒通道）");
          return credentials;
        }
      }
      if (!refresh) await sleep(pollMs);
    }
  }
}

/** 从 stdin 读取一行配对码（非交互环境 fail-closed，避免静默卡死）。 */
async function readVerifyCodeFromStdin(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new WeixinError(
      "validation",
      "微信要求输入配对码，但当前环境不能交互输入：请在终端里运行绑定命令后按提示输入",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
