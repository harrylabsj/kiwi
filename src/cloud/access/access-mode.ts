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
 * 商家工作台「接入方式」偏好。
 *
 * 这是**非凭据**的本地偏好。连接服务在本实例已绑定后，经 active binding
 * 私钥签名把它同步到 Catalog 的公开 `buyer_access` 投影；买家按该公开状态
 * 路由。本文件本身不直接进入买家路径，也不含分享码/绑定密钥。
 *
 * 本地模式还决定本实例读取公开 Agent Card 时如何尝试：
 *
 * - `auto`（缺省）：先无码读取；只有明确 401/403 且本进程持有已授权分享码
 *   时才追加分享码重试。单次失败不会被解释成平台已加白/未加白。
 * - `share_code`：显式使用分享码；没有可用分享码时明确要求商家重新提交。
 * - `no_share_code`：显式不使用分享码；即使目录里保存了分享码也不发送。
 *
 * 三个纪律：
 *
 * 1. 切换接入方式**不会**撤销目录配置、不会删除目录或本地已保存的分享码、
 *    也不会清除本进程已暂存的读卡凭据；只有显式 `revokeAccess` 才清。
 * 2. 本文件只保存模式字符串，不含分享码、链接、Cookie 或任何凭据。
 * 3. 读取/写入与 enrollment store 共用短锁和原子替换；旧实例没有文件时按
 *    `auto` 运行，不需要迁移或删除任何既有状态。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../../fs/atomic-write.js";
import { withEnrollmentStoreLock } from "../binding/store-lock.js";

export const ACCESS_MODE_FILE = "merchant-access-mode.json";
export const ACCESS_MODE_VERSION = 1;

/**
 * `no_share_code` 是“无分享码接入”的用户选项；错误/损坏文件永远回退
 * `auto`，绝不把损坏内容当成 `no_share_code` 或 `share_code`。
 */
export type MerchantAccessMode = "auto" | "share_code" | "no_share_code";

export const MERCHANT_ACCESS_MODES: readonly MerchantAccessMode[] = [
  "auto",
  "share_code",
  "no_share_code",
];

const MODE_SET = new Set<string>(MERCHANT_ACCESS_MODES);

/** 最近一次已确认写入目录的接入方式（用于 CAS 与“是否已同步”展示）。 */
export interface AccessModeCatalogState {
  readonly mode: MerchantAccessMode;
  /** 目录侧单调 revision；0 表示尚未成功写入过。 */
  readonly revision: number;
  readonly syncedAt: string;
}

export interface AccessModeState {
  readonly mode: MerchantAccessMode;
  /** 是否存在可读的持久化偏好；false 表示按缺省 auto 运行。 */
  readonly persisted: boolean;
  /** 文件存在但不可解析/形状不符；此时仍安全回退 auto，不删除文件。 */
  readonly invalid: boolean;
  /**
   * 目录同步元数据（可选、非凭据）。旧版本文件没有该字段；旧二进制读取
   * 带该字段的文件时仍只取 `mode`，因此可安全回滚。
   */
  readonly catalog?: AccessModeCatalogState;
}

export function accessModePath(dataDir: string): string {
  return path.join(dataDir, ACCESS_MODE_FILE);
}

export function isMerchantAccessMode(value: unknown): value is MerchantAccessMode {
  return typeof value === "string" && MODE_SET.has(value);
}

/**
 * 只读偏好。任何损坏/未知形状都回退 `auto`，绝不把损坏内容当成
 * `no_share_code` 或 `share_code`，也不触发任何网络或删除动作。
 */
export function readAccessMode(dataDir: string): AccessModeState {
  const file = accessModePath(dataDir);
  if (!existsSync(file)) return { mode: "auto", persisted: false, invalid: false };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      version?: unknown;
      mode?: unknown;
      catalog?: unknown;
    } | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.version !== ACCESS_MODE_VERSION ||
      !isMerchantAccessMode(parsed.mode)
    ) {
      return { mode: "auto", persisted: true, invalid: true };
    }
    const catalog = parseCatalogState(parsed.catalog);
    return {
      mode: parsed.mode,
      persisted: true,
      invalid: false,
      ...(catalog !== undefined ? { catalog } : {}),
    };
  } catch {
    return { mode: "auto", persisted: true, invalid: true };
  }
}

/** 目录同步元数据损坏只丢弃该元数据，不影响本地模式。 */
function parseCatalogState(value: unknown): AccessModeCatalogState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !isMerchantAccessMode(record["mode"]) ||
    typeof record["revision"] !== "number" ||
    !Number.isInteger(record["revision"]) ||
    record["revision"] < 0 ||
    typeof record["syncedAt"] !== "string" ||
    record["syncedAt"] === ""
  ) {
    return undefined;
  }
  return { mode: record["mode"], revision: record["revision"], syncedAt: record["syncedAt"] };
}

/**
 * 原子写入偏好。与 enrollment store 共用锁：并发读-改-写不会互相覆盖，也不会
 * 在写一半时留下可被当成 `no_share_code` 的部分文件。文件权限 0600。
 *
 * 只写模式文件；不会调用 Catalog，也不会触碰分享码 vault。
 */
export function writeAccessMode(
  dataDir: string,
  mode: MerchantAccessMode,
  catalog?: AccessModeCatalogState,
): AccessModeState {
  if (!isMerchantAccessMode(mode)) {
    throw new Error("unsupported merchant access mode");
  }
  let nextCatalog: AccessModeCatalogState | undefined = catalog;
  withEnrollmentStoreLock(dataDir, () => {
    if (nextCatalog === undefined) {
      // 未显式提供时保留已有同步元数据（例如用户在目录离线时改模式，
      // revision 仍可用于下一次 CAS），绝不因写模式而丢掉它。
      nextCatalog = readAccessMode(dataDir).catalog;
    }
    writeFileAtomic(
      accessModePath(dataDir),
      `${JSON.stringify({
        version: ACCESS_MODE_VERSION,
        mode,
        ...(nextCatalog !== undefined ? { catalog: nextCatalog } : {}),
      })}\n`,
      { mode: 0o600 },
    );
  });
  return {
    mode,
    persisted: true,
    invalid: false,
    ...(nextCatalog !== undefined ? { catalog: nextCatalog } : {}),
  };
}
