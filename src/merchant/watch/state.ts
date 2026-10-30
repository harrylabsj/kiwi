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
 * watch 去重/投递状态（`<dataDir>/watch/state.json`，0600 原子写）。
 *
 * 损坏状态 fail-closed：不从头回放历史（会把 61 场旧磋商重新通知一遍），
 * 由调用方提示修复或删除文件。目录 0700。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../../fs/atomic-write.js";

export interface WatchNegotiationState {
  last_event_digest: string;
  agreement: boolean;
  last_notified_at?: string;
}

export interface WatchApprovalState {
  status: string;
  updated_at: string;
  negotiation_id?: string;
  sku?: string;
  notified_at?: string;
}

export interface WatchQueueItem {
  key: string;
  /** 每个渠道各自的文本（已渲染；0600 文件内可能含金额）。 */
  texts: Record<string, string>;
  attempts: number;
  next_at: string;
}

export interface WatchState {
  version: 1;
  updated_at: string;
  initialized_at?: string;
  negotiations: Record<string, WatchNegotiationState>;
  approvals: Record<string, WatchApprovalState>;
  queue: WatchQueueItem[];
}

export function emptyWatchState(now: string): WatchState {
  return { version: 1, updated_at: now, negotiations: {}, approvals: {}, queue: [] };
}

export class WatchStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchStateError";
  }
}

export function watchStatePath(dataDir: string): string {
  return path.join(dataDir, "watch", "state.json");
}

export function loadWatchState(file: string, now: string): WatchState {
  if (!existsSync(file)) return emptyWatchState(now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new WatchStateError(
      `watch 状态文件损坏（${file}）；修复或删除后重启：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new WatchStateError(`watch 状态文件损坏（${file}）；修复或删除后重启`);
  }
  const raw = parsed as Partial<WatchState>;
  if (raw.version !== 1 || typeof raw.negotiations !== "object" || typeof raw.approvals !== "object") {
    throw new WatchStateError(`watch 状态文件版本/形状不受支持（${file}）`);
  }
  return {
    version: 1,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : now,
    ...(typeof raw.initialized_at === "string" ? { initialized_at: raw.initialized_at } : {}),
    negotiations: raw.negotiations ?? {},
    approvals: raw.approvals ?? {},
    queue: Array.isArray(raw.queue) ? raw.queue : [],
  };
}

export function saveWatchState(file: string, state: WatchState): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
