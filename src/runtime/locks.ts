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
 * 显式锁恢复（review P1-4/P1-8 的运营出口）。
 *
 * `canTakeOverStaleLock` 只在**同 host 且可证明持有者已死**时自动接管；
 * 不同 host / 信息不全的残留锁按设计保持 fail-closed。没有出口时运营者只能
 * 手工删文件且不知道删哪一个——本模块提供只读盘点与**逐文件显式恢复**：
 *
 * - 自动可接管（同 host + boot_id 变化或 pid 不存在）→ 无需 `--force`；
 * - 跨 host / 无法证明 → 必须 `--force`（运营者显式断言 owner 已死）。
 *
 * 恢复只删除**已指名**的锁文件，不做任何目录级通配删除。
 */
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { ledgerFileName } from "../negotiation/ledger/store.js";
import { canTakeOverStaleLock, isProcessAlive } from "./lock-owner.js";

export type LockKind = "ledger" | "ledger_guard" | "enrollment" | "enrollment_claim";

export interface LockFileStatus {
  path: string;
  kind: LockKind;
  owner?: {
    token?: string;
    pid?: number;
    host?: string;
    boot_id?: string;
    state?: string;
  };
  /** 同 host 且可证明已死（自动接管判定）。 */
  autoRecoverable: boolean;
  /** 仅同 host 时给出；跨 host 为 undefined（无法判断）。 */
  ownerAlive?: boolean;
}

export interface LockRecoveryOptions {
  force?: boolean;
  currentHost?: string;
}

export interface LockRecoveryResult {
  removed: string[];
  refused: Array<{ path: string; reason: string }>;
}

function parseOwner(raw: string): LockFileStatus["owner"] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.token === "string" ? { token: record.token } : {}),
      ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
      ...(typeof record.host === "string" ? { host: record.host } : {}),
      ...(typeof record.boot_id === "string" ? { boot_id: record.boot_id } : {}),
      ...(typeof record.state === "string" ? { state: record.state } : {}),
    };
  } catch {
    return undefined;
  }
}

function inspect(pathname: string, kind: LockKind, options: LockRecoveryOptions): LockFileStatus {
  let raw: string;
  try {
    raw = readFileSync(pathname, "utf8");
  } catch {
    return { path: pathname, kind, autoRecoverable: false };
  }
  const owner = parseOwner(raw);
  const sameHost = owner?.host !== undefined && owner.host === (options.currentHost ?? hostname());
  return {
    path: pathname,
    kind,
    ...(owner === undefined ? {} : { owner }),
    autoRecoverable: canTakeOverStaleLock(raw, {
      ...(options.currentHost === undefined ? {} : { currentHost: options.currentHost }),
    }),
    ...(sameHost && owner?.pid !== undefined ? { ownerAlive: isProcessAlive(owner.pid) } : {}),
  };
}

function ledgerLockPaths(dataDir: string, negotiationId: string): { main: string; guard: string } {
  const main = path.join(dataDir, "ledger", `${ledgerFileName(negotiationId)}.lock`);
  return { main, guard: `${main}.guard` };
}

/** 盘点 data dir 下所有已知锁文件（只读，缺失目录返回空）。 */
export function listLocks(
  dataDir: string,
  options: LockRecoveryOptions = {},
): LockFileStatus[] {
  const results: LockFileStatus[] = [];
  const ledgerDir = path.join(dataDir, "ledger");
  try {
    for (const name of readdirSync(ledgerDir).sort()) {
      if (name.endsWith(".lock.guard")) {
        results.push(inspect(path.join(ledgerDir, name), "ledger_guard", options));
      } else if (name.endsWith(".lock")) {
        results.push(inspect(path.join(ledgerDir, name), "ledger", options));
      }
    }
  } catch {
    /* 目录不存在 = 无 ledger 锁 */
  }
  const enrollment = path.join(dataDir, "merchant-enrollments.lock");
  try {
    statSync(enrollment);
    results.push(inspect(enrollment, "enrollment", options));
  } catch {
    /* 不存在 */
  }
  try {
    for (const name of readdirSync(dataDir).sort()) {
      if (/^enrollment-create-[0-9a-f]{64}\.claim$/.test(name)) {
        results.push(inspect(path.join(dataDir, name), "enrollment_claim", options));
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return results;
}

function recoverOne(
  pathname: string,
  options: LockRecoveryOptions,
): { removed: boolean; reason?: string } {
  const status = inspect(pathname, "ledger", options);
  if (status.autoRecoverable) {
    unlinkSync(pathname);
    return { removed: true };
  }
  if (options.force === true) {
    unlinkSync(pathname);
    return { removed: true };
  }
  return {
    removed: false,
    reason:
      "owner is alive, on another host, or unverifiable; inspect it and rerun with --force",
  };
}

/**
 * 恢复单个 negotiation 的 ledger 主锁 + guard。
 *
 * 返回逐文件结果；任一文件被拒绝时其他文件仍按各自判定处理（运营者可以
 * 先清 guard 再等主锁超时，或反之）。
 */
export function recoverLedgerLock(
  dataDir: string,
  negotiationId: string,
  options: LockRecoveryOptions = {},
): LockRecoveryResult {
  const result: LockRecoveryResult = { removed: [], refused: [] };
  const { guard, main } = ledgerLockPaths(dataDir, negotiationId);
  for (const pathname of [guard, main]) {
    if (!exists(pathname)) continue;
    try {
      const outcome = recoverOne(pathname, options);
      if (outcome.removed) result.removed.push(pathname);
      else result.refused.push({ path: pathname, reason: outcome.reason ?? "refused" });
    } catch (error) {
      result.refused.push({
        path: pathname,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

function exists(pathname: string): boolean {
  try {
    statSync(pathname);
    return true;
  } catch {
    return false;
  }
}

/**
 * 恢复 enrollment store 锁与（可选）已指名的 unresolved creation claim。
 *
 * *claimName* 必须是 data dir 下的 `enrollment-create-<64 hex>.claim` 文件名；
 * 拒绝任何路径穿越/通配。
 */
export function recoverEnrollmentLocks(
  dataDir: string,
  options: LockRecoveryOptions & { claimName?: string } = {},
): LockRecoveryResult {
  const result: LockRecoveryResult = { removed: [], refused: [] };
  const targets: string[] = [path.join(dataDir, "merchant-enrollments.lock")];
  if (options.claimName !== undefined && options.claimName !== "") {
    if (!/^enrollment-create-[0-9a-f]{64}\.claim$/.test(options.claimName)) {
      result.refused.push({
        path: options.claimName,
        reason: "claim name must match enrollment-create-<64 hex>.claim",
      });
      return result;
    }
    targets.push(path.join(dataDir, options.claimName));
  }
  for (const pathname of targets) {
    if (!exists(pathname)) continue;
    try {
      const outcome = recoverOne(pathname, options);
      if (outcome.removed) result.removed.push(pathname);
      else result.refused.push({ path: pathname, reason: outcome.reason ?? "refused" });
    } catch (error) {
      result.refused.push({
        path: pathname,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
