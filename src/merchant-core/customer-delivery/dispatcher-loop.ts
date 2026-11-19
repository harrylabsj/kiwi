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
 * P1 投递运行时（M6-6）：在治理所有权持有进程内定期领取 PENDING 通知并发送。
 *
 * 单流在途、UNKNOWN 阻塞、accepted≠read 均由 `dispatchDelivery`/仓库保证；
 * 本循环只做调度与渠道选择。无对应适配器时保留 PENDING，不算失败。
 */

import type { DeliveryEvidence } from "./reconciliation.js";
import type { DeliveryChannelAdapter } from "./channel.js";
import type { DeliveryRecord, DeliveryStore } from "./dispatcher.js";
import { dispatchDelivery } from "./channel.js";

export interface CustomerDeliveryRepositoryLike extends DeliveryStore {
  listDue(merchantId: string, now: string, limit?: number): DeliveryRecord[];
  recoverExpiredClaims?(merchantId: string, now: string): number;
  listByStatus?(merchantId: string, status: "UNKNOWN", limit: number, offset?: number): DeliveryRecord[];
  countUnknown?(merchantId: string): number;
  reconcileUnknown?(record: DeliveryRecord, evidence: DeliveryEvidence): boolean;
}

export interface DeliveryDispatcherLoopOptions {
  readonly store: CustomerDeliveryRepositoryLike;
  readonly reconcile?: (record: DeliveryRecord) => Promise<DeliveryEvidence | undefined>;
  readonly streamGate?: import("./stream-gate.js").StreamGate;
  readonly merchant_id: string;
  readonly adapterFor: (delivery: DeliveryRecord) => DeliveryChannelAdapter | undefined;
  /** 发送时复核（P1-4）：重读绑定/订阅/频控；抛错则不领取。 */
  readonly authorize?: (delivery: DeliveryRecord) => void;
  /** 按授权绑定解析收件人（P1-5）；缺省时适配器必须自行拒绝发送。 */
  readonly resolveRecipient?: (delivery: DeliveryRecord) => string | undefined;
  readonly now: () => string;
  readonly assertOwner?: () => void;
  readonly write?: <T>(work: () => T) => T;
  readonly worker_id?: string;
  readonly interval_ms?: number;
  readonly lease_ms?: number;
  readonly timeout_ms?: number;
  readonly max_per_tick?: number;
  readonly log?: (line: string) => void;
}

export class DeliveryDispatcherLoop {
  private readonly options: DeliveryDispatcherLoopOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 重入互斥：SetInterval tick 不重叠（P1-2）。 */
  private ticking = false;
  private reconciliationOffset = 0;
  private nextUnknownReportAt = 0;

  constructor(options: DeliveryDispatcherLoopOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.options.log?.(`[delivery dispatcher] tick failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }, this.options.interval_ms ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<{ claimed: number; sent: number; unknown: number; skipped: number }> {
    const result = { claimed: 0, sent: 0, unknown: 0, skipped: 0 };
    // 上一 tick 的渠道调用仍挂起时直接跳过，避免同一循环双重领取。
    if (this.ticking) return result;
    this.ticking = true;
    try {
      this.options.assertOwner?.();
      const worker = this.options.worker_id ?? `delivery:${process.pid}`;
      const now = this.options.now();
      const recover = () => this.options.store.recoverExpiredClaims?.(this.options.merchant_id, now) ?? 0;
      result.unknown += this.options.write === undefined ? recover() : this.options.write(recover);
      if (result.unknown > 0) {
        this.options.log?.(`[delivery dispatcher] ${result.unknown} interrupted deliveries require reconciliation\n`);
      }
      if (this.options.reconcile !== undefined) {
        const batchSize = 5;
        const merchantId = this.options.merchant_id;
        const unknown = this.options.store.listByStatus?.(merchantId, "UNKNOWN", batchSize, this.reconciliationOffset) ?? [];
        let settled = 0;
        for (const record of unknown) {
          const evidence = await this.options.reconcile(record);
          if (evidence === undefined) continue;
          const settle = () => this.options.store.reconcileUnknown?.(record, evidence) ?? false;
          if (this.options.write === undefined ? settle() : this.options.write(settle)) settled += 1;
        }
        this.reconciliationOffset = unknown.length < batchSize ? 0 : this.reconciliationOffset + unknown.length - settled;
      }
      if (Date.parse(now) >= this.nextUnknownReportAt) {
        this.nextUnknownReportAt = Date.parse(now) + 60 * 60 * 1000;
        const unknownCount = this.options.store.countUnknown?.(this.options.merchant_id) ?? 0;
        if (unknownCount > 0) {
          this.options.log?.(`[delivery dispatcher] ${unknownCount} deliveries awaiting verification\n`);
        }
      }
      const due = this.options.store.listDue(
        this.options.merchant_id,
        now,
        this.options.max_per_tick ?? 10,
      );
      for (const record of due) {
        const adapter = this.options.adapterFor(record);
        if (adapter === undefined) {
          result.skipped += 1;
          continue;
        }
        const run = () =>
          dispatchDelivery({
            store: this.options.store,
            merchant_id: this.options.merchant_id,
            delivery_id: record.delivery_id,
            worker_id: worker,
            lease_ms: this.options.lease_ms ?? 120_000,
            timeout_ms: this.options.timeout_ms ?? 60_000,
            now: this.options.now(),
            clock: this.options.now,
            adapter,
            ...(this.options.streamGate !== undefined ? { stream_gate: this.options.streamGate } : {}),
            ...(this.options.write !== undefined ? { write: this.options.write } : {}),
            ...(this.options.authorize !== undefined ? { authorize: this.options.authorize } : {}),
            ...(this.options.resolveRecipient !== undefined
              ? { resolveRecipient: this.options.resolveRecipient }
              : {}),
          });
        try {
          // 渠道调用在领取和结算事务之间执行。
          const sent = await run();
          result.claimed += 1;
          if (sent.status === "UNKNOWN") {
            result.unknown += 1;
            this.options.log?.(`[delivery dispatcher] ${sent.delivery_id} requires reconciliation\n`);
          } else if (sent.status === "SENT") result.sent += 1;
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code;
          if (code === "not_acquired" || code === "feature_disabled") {
            this.stop();
            break;
          }
          result.skipped += 1;
          this.options.log?.(`[delivery dispatcher] ${record.delivery_id}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }
}
