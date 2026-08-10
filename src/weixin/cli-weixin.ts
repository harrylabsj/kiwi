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
 * `kiwi weixin` 命令——微信远程控制通道入口。
 *
 * 接线对齐 cmdChat：profile 加载 → buildChatKernel → （可选 --a2a 节点）→
 * WeixinChannel.open（登录或加载凭证）→ run()；SIGINT/SIGTERM 优雅关闭。
 * A2A 节点默认关（headless 控制面收窄攻击面），--a2a 开启。
 */

import { buildChatKernel, defaultChatProfile } from "../agent/kernel-builder.js";
import type { A2aNodeHandle } from "../a2a/node.js";
import { startA2aNode } from "../a2a/node.js";
import { loadProfile } from "../config/profile.js";
import { EXIT } from "../exit-codes.js";
import { DEFAULT_CATALOG_URL } from "../product-cli.js";
import { agentDataDir, ensurePathsForDir } from "../agent/agent-db.js";
import { WeixinChannel } from "./channel.js";
import { credentialsPathFor, syncStatePathFor } from "./credentials.js";
import { ILINK_DEFAULT_BASE_URL } from "./types.js";

export function weixinUsage(): string {
  return `kiwi weixin — 微信远程控制通道（iLink Bot）

Usage:
  kiwi weixin [--profile FILE] [--data-dir DIR] [--allow id1,id2] [--relogin]
              [--a2a] [--port N] [--qr-scale 1|2] [--no-qr]

  --profile FILE     profile（缺省 defaultChatProfile，同裸 kiwi）
  --data-dir DIR     kernel 数据目录 + 微信凭证/游标（缺省 agentDataDir）
  --allow id,…       额外授权微信用户（配对扫描者始终自动授权）
  --relogin          丢弃已存凭证重新扫码（会话过期/换设备时）
  --a2a              同时启动 A2A 节点（默认关；port 复用 --port）
  --qr-scale N       终端二维码每模块列数（1 或 2；默认 1）
  --no-qr            仅打印 URL + 提示（兜底；默认渲染二维码）

扫码登录后微信发消息即远程控制 kiwi（对话 + /slash 命令：
/mode /approve /reject /status /quit 等）。首次请先发一句任意消息唤醒通道。
`;
}

export interface WeixinCliArgs {
  profile?: string;
  dataDir?: string;
  allow?: string;
  relogin: boolean;
  a2a: boolean;
  port?: number;
  qrScale: number;
  noQr: boolean;
  catalog?: string;
}

/** `kiwi weixin` 主入口。返回进程退出码（0 OK / 2 CONFIG / 3 AUTH / 10 TRANSIENT）。 */
export async function cmdWeixin(args: WeixinCliArgs): Promise<number> {
  const profile = args.profile !== undefined ? loadProfile(args.profile) : defaultChatProfile();
  const catalog = args.catalog ?? process.env.KIWI_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const dataDir = args.dataDir ?? agentDataDir(profile.agent_id);
  ensurePathsForDir(dataDir);

  const kernel = await buildChatKernel(profile, dataDir, catalog);

  let node: A2aNodeHandle | null = null;
  if (args.a2a) {
    try {
      node = await startA2aNode({
        profile,
        catalog,
        preferredPort: args.port,
        ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
        ownerTokenSecret: process.env.KIWI_CATALOG_OWNER_TOKEN_SECRET,
      });
      process.stderr.write(
        `[a2a] ${node.role}@${node.url}${node.catalogAgentId !== undefined ? ` registered ${node.catalogAgentId}` : ""}\n`,
      );
    } catch (err) {
      process.stderr.write(`[a2a] 节点启动失败（微信通道继续）：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // 白名单：--allow > KIWI_WEIXIN_ALLOW_USERS > profile weixin.allow_users
  const allowUsers = resolveAllowUsers(args.allow, profile.weixin?.allow_users);

  // base URL：KIWI_WEIXIN_BASE_URL > profile weixin.base_url > 默认
  const apiBaseUrl =
    process.env.KIWI_WEIXIN_BASE_URL ?? profile.weixin?.base_url ?? ILINK_DEFAULT_BASE_URL;

  let channel: WeixinChannel | null = null;
  const shutdown = async (code: number): Promise<never> => {
    await channel?.stop().catch(() => undefined);
    await node?.stop().catch(() => undefined);
    await kernel.close().catch(() => undefined);
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  try {
    channel = await WeixinChannel.open({
      kernel,
      apiBaseUrl,
      credentialsPath: credentialsPathFor(dataDir),
      syncBufPath: syncStatePathFor(dataDir),
      allowUsers,
      forceRelogin: args.relogin,
      ...(args.qrScale > 1 ? { qrScale: args.qrScale } : {}),
      renderQr: args.noQr
        ? undefined
        : (qr) => {
            for (const line of qr) process.stdout.write(`${line}\n`);
          },
      notice: (line) => process.stderr.write(`${line}\n`),
    });
    const exitCode = await channel.run();
    return exitCode;
  } catch (err) {
    process.stderr.write(
      `[weixin] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return EXIT.CONFIG;
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    await channel?.stop().catch(() => undefined);
    await node?.stop().catch(() => undefined);
    await kernel.close().catch(() => undefined);
  }
}

/** 白名单合并：--allow（逗号分隔）> env > profile。 */
function resolveAllowUsers(cliAllow: string | undefined, profileAllow: string[] | undefined): string[] {
  const env = process.env.KIWI_WEIXIN_ALLOW_USERS;
  const source = cliAllow ?? env ?? (profileAllow !== undefined ? profileAllow.join(",") : undefined);
  if (source === undefined || source === "") return [];
  return source
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
