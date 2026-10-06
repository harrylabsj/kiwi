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
 * 独立 Merchant Runtime 的设备授权、自动绑定和名片发布（**CLI 适配层**）。
 *
 * 协议状态机本体在 `connect-service.ts`（createMerchantConnectionService）；
 * 本文件只做四件 CLI 特有的事：
 *
 *   1. `parsePublicOrigin` 的公网入口校验（私网/非 https/带路径一律拒绝）；
 *   2. 把 begin() 拿到的本人配对信息打印到**商家本机**终端并代开浏览器；
 *      配对码只出现在这里——服务端后台路径（connect-service）永不输出它；
 *   3. 在授权截止前以 1s 步长驱动 reconcile()（实际 poll 间隔由服务按
 *      interval/slow_down 节流）；
 *   4. 用与旧版逐字相同的 MerchantConnectError 错误码向上传递失败。
 *
 * 对外契约（函数签名、options 形状、返回 {agentId, bindingId, cardRevision}、
 * 错误码与文案）与抽取前保持一致；`selectReusableEnrollment` /
 * `priorPublishedCatalogAgentId` 实现移至 connect-service.ts，这里再导出以
 * 兼容既有引用（tests/merchant-connect-migration.test.ts）。
 */

import type { AgentProfile } from "../config/profile.js";
import {
  createMerchantConnectionService,
  isPublicHostAllowed,
  MerchantConnectError,
  type ConnectionSummary,
} from "./connect-service.js";

export {
  MerchantConnectError,
  priorPublishedCatalogAgentId,
  selectReusableEnrollment,
} from "./connect-service.js";

function parsePublicOrigin(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new MerchantConnectError("PUBLIC_ORIGIN_MISSING", "商家服务还没有可用的公网 HTTPS 入口，买家暂时无法连接并询价。请先运行 `kiwi merchant setup-public` 查看 DNS/Caddy 配置指引，或使用 WorkBuddy 云端应用；完成后重新运行 `kiwi merchant connect`，已有资料会保留。地址格式通过不代表外部可访问，Catalog 还会执行真实端点挑战。");
  }
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new MerchantConnectError("PUBLIC_ORIGIN_INVALID", "公网入口不是合法 URL；请设置 KIWI_A2A_PUBLIC_URL=https://你的域名");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "") || !isPublicHostAllowed(host)) {
    throw new MerchantConnectError("PUBLIC_ORIGIN_INVALID", "商家服务尚未配置可用的公网 HTTPS origin。请运行 `kiwi merchant setup-public` 查看入口配置指引；资料已保留，配置后重新运行连接命令。");
  }
  return url.origin;
}

export interface MerchantConnectOptions {
  profile: AgentProfile;
  dataDir: string;
  catalogUrl: string;
  publicOrigin?: string;
  openBrowser?: (url: string) => void;
  output?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 失败时保留设备状态、许可与绑定回执；重跑命令按相同 enrollment 继续。 */
export async function connectMerchant(options: MerchantConnectOptions): Promise<{ agentId: string; bindingId: string; cardRevision: number }> {
  if (options.profile.role !== "merchant") throw new MerchantConnectError("PROFILE_NOT_MERCHANT", "kiwi merchant connect 需要 merchant profile");
  const origin = parsePublicOrigin(options.publicOrigin ?? process.env.KIWI_A2A_PUBLIC_URL);
  const output = options.output ?? ((line: string): void => {
    process.stdout.write(`${line}\n`);
  });
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const service = createMerchantConnectionService({
    dataDir: options.dataDir,
    catalogUrl: options.catalogUrl,
    publicOrigin: origin,
    generation: 1,
    serviceEpoch: 1,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const completed = (summary: ConnectionSummary): { agentId: string; bindingId: string; cardRevision: number } => {
    if (!summary.published || summary.agentId === null || summary.bindingId === null || summary.cardRevision === null) {
      throw new MerchantConnectError("STATE_INCOMPLETE", "连接流程尚未完成，未显示已上线。");
    }
    return { agentId: summary.agentId, bindingId: summary.bindingId, cardRevision: summary.cardRevision };
  };

  // begin() 幂等：已 published 且 Catalog 侧仍 ACTIVE 时直接回结果；
  // 已暂停/撤回时 begin() 抛 PUBLICATION_NOT_ACTIVE（与旧版一致）。
  const first = await service.begin();
  if (first.published) return completed(first);

  if (first.status === "awaiting_confirmation") {
    const pairing = service.getPairing();
    if (pairing === null) {
      throw new MerchantConnectError("STATE_INVALID", "本地接入任务缺少配对信息，已停止。");
    }
    output(`即将授权连接 ${options.profile.name ?? options.profile.agent_id}（配对码 ${pairing.userCode}）。请在 Catalog 页面确认店铺公开信息；不要把配对码发给他人。`);
    options.openBrowser?.(pairing.verificationUri);
    output(`授权页面：${pairing.verificationUri}`);
    output("Runtime 已开始等待登录与一次「连接此服务并发布」确认；可 Ctrl+C 后重新运行命令继续。");
    const deadline = Math.min(Date.parse(pairing.expiresAt), now().getTime() + (options.timeoutMs ?? 10 * 60_000));
    let summary = first;
    while (summary.status === "awaiting_confirmation") {
      if (now().getTime() >= deadline) break;
      await sleep(1_000);
      summary = await service.reconcile();
    }
    if (summary.status === "awaiting_confirmation") {
      throw new MerchantConnectError("AUTHORIZATION_PENDING", "尚未完成商家授权。会话已保存，运行 kiwi merchant connect 可继续。");
    }
  }

  // 授权已完成（或本次续办从 authorized/bound 起步）：单趟级联到 published。
  return completed(await service.reconcile());
}
