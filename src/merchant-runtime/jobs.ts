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
 * Merchant 实例周期任务骨架（V2 阶段一：src/merchant-runtime/jobs.ts）。
 *
 * 本轮落地：健康轮询（health-poll，刷新 capability-probe 与健康报告）+
 * 持续备份接缝（backup hook——备份实现放阶段四，本轮注册即明确报「未实现」，
 * 不静默假装已备份）。任务串行执行、异常隔离（单个任务失败不影响其他任务
 * 与宿主进程），错误进最近运行记录。
 */

export interface MerchantJob {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
}

export interface MerchantJobRunRecord {
  name: string;
  last_run_at?: string;
  last_error?: string;
  runs: number;
}

export class MerchantJobs {
  private readonly jobs = new Map<string, MerchantJob>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly records = new Map<string, MerchantJobRunRecord>();
  /** 在途任务（审查 P2：重入保护，防长备份与健康轮询自我重叠）。 */
  private readonly inFlight = new Set<string>();
  private readonly now: () => string;
  private running = false;

  constructor(options: { now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  register(job: MerchantJob): void {
    if (this.jobs.has(job.name)) throw new Error(`job ${job.name} 已注册`);
    if (!(job.intervalMs > 0)) throw new Error(`job ${job.name} intervalMs 必须 > 0`);
    this.jobs.set(job.name, job);
    this.records.set(job.name, { name: job.name, runs: 0 });
  }

  /** 立即执行一次（异常隔离：记录 last_error，不抛出）。同任务在途时跳过
   *  （审查 P2：与「串行执行」文档口径一致——长任务不与下一轮并发重叠）。 */
  async runOnce(name: string): Promise<MerchantJobRunRecord> {
    const job = this.jobs.get(name);
    if (job === undefined) throw new Error(`未知任务 ${name}`);
    if (this.inFlight.has(name)) {
      const record = this.records.get(name) as MerchantJobRunRecord;
      record.last_run_at = this.now();
      return { ...record };
    }
    this.inFlight.add(name);
    const record = this.records.get(name) as MerchantJobRunRecord;
    try {
      await job.run();
      record.last_run_at = this.now();
      record.last_error = undefined;
    } catch (err) {
      record.last_run_at = this.now();
      record.last_error = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlight.delete(name);
    }
    record.runs += 1;
    return { ...record };
  }

  /** 启动全部周期任务。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const [name, job] of this.jobs) {
      const timer = setInterval(() => {
        void this.runOnce(name);
      }, job.intervalMs);
      timer.unref();
      this.timers.set(name, timer);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  list(): MerchantJobRunRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }
}

/**
 * 标准任务集：健康轮询 + 持续备份接缝。
 * backupHook 缺省 = 阶段四未实现的明确接缝（记录错误，绝不静默成功）。
 */
export function standardMerchantJobs(deps: {
  healthPoll: () => Promise<void>;
  backupHook?: () => Promise<void>;
  healthIntervalMs?: number;
  backupIntervalMs?: number;
}): MerchantJob[] {
  return [
    {
      name: "health-poll",
      intervalMs: deps.healthIntervalMs ?? 60_000,
      run: deps.healthPoll,
    },
    {
      name: "backup",
      intervalMs: deps.backupIntervalMs ?? 5 * 60_000,
      run:
        deps.backupHook ??
        (async () => {
          throw new Error("持续备份未实现（阶段四）；本轮为显式接缝，不静默假装已备份");
        }),
    },
  ];
}
