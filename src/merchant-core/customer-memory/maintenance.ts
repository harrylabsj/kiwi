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
 * 客户数据保留期清算调度（审查 P1-7）。
 *
 * `CustomerMemoryService.expireDue` 与 `DataUseGrantStore.expireDue` 只有
 * 接入周期性 tick 才真正执行保留承诺；本模块把它们放进同一所有权栅栏内，
 * 由持有写权的进程每小时执行一次（与 OperationsScheduler 并列）。
 */

import type { DatabaseSync } from "node:sqlite";

import { DataUseGrantStore } from "../context-governance/data-use-grant.js";
import { CustomerMemoryService } from "./memory.js";

export interface CustomerDataMaintenanceOptions {
  readonly db: DatabaseSync;
  readonly now: () => string;
  /** 所有权栅栏：丢失写权时抛错，tick 只记日志不写库。 */
  readonly write: <T>(work: () => T) => T;
  readonly interval_ms?: number;
  readonly log?: (line: string) => void;
}

export interface CustomerDataMaintenanceResult {
  readonly memories: number;
  readonly history: number;
  readonly grants: number;
}

export class CustomerDataMaintenance {
  private readonly options: CustomerDataMaintenanceOptions;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: CustomerDataMaintenanceOptions) {
    this.options = options;
  }

  runOnce(): CustomerDataMaintenanceResult {
    const memory = new CustomerMemoryService({
      db: this.options.db,
      now: this.options.now,
    });
    const grants = new DataUseGrantStore({ db: this.options.db, now: this.options.now });
    return this.options.write(() => {
      const expired = memory.expireDue();
      return { ...expired, grants: grants.expireDue() };
    });
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      try {
        this.runOnce();
      } catch (err) {
        this.options.log?.(
          `[customer data maintenance] tick failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }, this.options.interval_ms ?? 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
