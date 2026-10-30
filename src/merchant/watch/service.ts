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
 * watch 守护循环：轮询磋商/审批快照 → 检测可行动事件 → 多渠道投递。
 *
 * 投递语义至少一次：发送成功/失败的渠道分别记账；失败进持久化队列，
 * 5s/30s/2m/10m 退避，5 次后放弃并记日志。单渠道失败不影响其他渠道。
 */

import path from "node:path";

import type { NegotiationOps } from "../negotiation-ops.js";
import { detectNotifications, type WatchNotification } from "./detect.js";
import type { WatchChannel } from "./notify.js";
import {
  loadWatchState,
  saveWatchState,
  watchStatePath,
  type WatchQueueItem,
  type WatchState,
} from "./state.js";

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
const MAX_ATTEMPTS = 5;

export interface MerchantWatchServiceOptions {
  dataDir: string;
  ops: NegotiationOps;
  channels: readonly WatchChannel[];
  intervalMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export class MerchantWatchService {
  private readonly statePath: string;
  private readonly channels: readonly WatchChannel[];
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private ticking: Promise<void> | null = null;

  constructor(private readonly options: MerchantWatchServiceOptions) {
    this.channels = options.channels;
    this.intervalMs = Math.max(5_000, options.intervalMs ?? 10_000);
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.statePath = watchStatePath(path.resolve(options.dataDir));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.ticking !== null) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    let state: WatchState;
    try {
      state = loadWatchState(this.statePath, this.now().toISOString());
    } catch (err) {
      this.log(`[watch] ${err instanceof Error ? err.message : String(err)}`);
      this.running = false;
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
      return;
    }

    let snapshot: ReturnType<NegotiationOps["snapshot"]>;
    try {
      snapshot = this.options.ops.snapshot();
    } catch (err) {
      this.log(`[watch] 读取磋商快照失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const detected = detectNotifications(state, snapshot, {
      channels: this.channels.map((channel) => channel.name),
      now: this.now(),
    });
    state = detected.next;

    for (const notification of detected.notifications) {
      await this.deliver(state, notification);
    }
    await this.retryQueue(state);
    state.updated_at = this.now().toISOString();
    try {
      saveWatchState(this.statePath, state);
    } catch (err) {
      this.log(`[watch] 状态写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async deliver(state: WatchState, notification: WatchNotification): Promise<void> {
    const failed: Record<string, string> = {};
    for (const channel of this.channels) {
      const text = notification.texts[channel.name];
      if (text === undefined) continue;
      try {
        await channel.send(text);
      } catch (err) {
        failed[channel.name] = text;
        this.log(
          `[watch] ${channel.name} 投递失败 ${notification.key}：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (Object.keys(failed).length > 0) {
      state.queue.push({
        key: notification.key,
        texts: failed,
        attempts: 0,
        next_at: new Date(this.now().getTime() + RETRY_DELAYS_MS[0]!).toISOString(),
      });
    }
  }

  private async retryQueue(state: WatchState): Promise<void> {
    const now = this.now().getTime();
    const pending: WatchQueueItem[] = [];
    for (const item of state.queue) {
      if (Date.parse(item.next_at) > now) {
        pending.push(item);
        continue;
      }
      const failed: Record<string, string> = {};
      for (const [name, text] of Object.entries(item.texts)) {
        const channel = this.channels.find((candidate) => candidate.name === name);
        if (channel === undefined) continue;
        try {
          await channel.send(text);
        } catch {
          failed[name] = text;
        }
      }
      if (Object.keys(failed).length === 0) continue;
      const attempts = item.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        this.log(`[watch] 放弃投递 ${item.key}（${attempts} 次失败）`);
        continue;
      }
      pending.push({
        ...item,
        texts: failed,
        attempts,
        next_at: new Date(now + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)]!).toISOString(),
      });
    }
    state.queue = pending;
  }
}
