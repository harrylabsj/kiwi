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
 * 回执投递调度（买家识别与交易回执 · K5/K6/K7 共享组件）。
 *
 * 入队即尝试投递；失败按 outbox 退避保留 PENDING。`drain()` 在启动与
 * 定时器中调用——重启补报同一 event ID，Catalog 幂等去重。回执接口
 * 故障绝不阻塞本地业务流程（提交本地事实 → 入队 → 异步投递）。
 */

import { ReceiptHttpError, type CommerceReceipt, type ReceiptOutbox, type ReceiptSubmitter } from "./receipts.js";

export interface ReceiptDispatcherOptions {
  outbox: ReceiptOutbox;
  submitter: ReceiptSubmitter;
  logError?: (message: string, err: unknown) => void;
}

export class ReceiptDispatcher {
  private readonly outbox: ReceiptOutbox;
  private readonly submitter: ReceiptSubmitter;
  private readonly logError: (message: string, err: unknown) => void;
  private draining = false;
  private drainRequested = false;

  constructor(options: ReceiptDispatcherOptions) {
    this.outbox = options.outbox;
    this.submitter = options.submitter;
    this.logError = options.logError ?? (() => {});
  }

  /** 业务事实提交后调用：入队 + 立即尽力投递（失败留在队列）。 */
  async enqueueAndDeliver(receipt: CommerceReceipt): Promise<void> {
    this.record(receipt);
    await this.drain();
  }

  record(receipt: CommerceReceipt): void {
    this.outbox.enqueue(receipt);
  }

  replayLedger(file: string, version: string, replay: () => void): void {
    this.outbox.replayLedger(file, version, replay);
  }

  kick(): void {
    queueMicrotask(() => void this.drain().catch((error) => this.logError("receipt drain failed", error)));
  }

  /** 补报（启动/定时）：同 event ID 重投由 Catalog 幂等吸收。 */
  async drain(): Promise<number> {
    if (this.draining) {
      this.drainRequested = true;
      return 0;
    }
    this.draining = true;
    let delivered = 0;
    try {
      do {
        this.drainRequested = false;
        for (const entry of this.outbox.due()) {
          try {
            await this.submitter.submit(entry.receipt);
            this.outbox.markDelivered(entry.event_id);
            delivered += 1;
          } catch (err) {
            // An unchanged POST cannot correct a disallowed method or a retired
            // endpoint. A 404 can be temporary during a Catalog rollout.
            if (err instanceof ReceiptHttpError && [400, 405, 409, 410, 413, 422].includes(err.status)) {
              this.outbox.markBlocked(entry.event_id, err.message);
              this.logError(`receipt ${entry.event_id} requires correction`, err);
              continue;
            }
            this.outbox.markFailed(entry.event_id, err instanceof Error ? err.message : String(err));
            this.logError(`receipt ${entry.event_id} delivery deferred`, err);
          }
        }
      } while (this.drainRequested);
    } finally {
      this.draining = false;
    }
    return delivered;
  }
}
