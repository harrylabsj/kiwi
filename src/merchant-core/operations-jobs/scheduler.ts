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
 * 经营任务运行时调度（设计 §15.2 / M6-5 前后）。
 *
 * 只由治理所有权持有者启动：每个 tick 先核验所有权，评估到期规则、领取
 * 规则任务、在事务外运行模型建议，再用 commitInternalResult 原子提交。
 * 失败/超时走 FAILED + 退避；所有权丢失立即停止且不写业务结果。
 */

import type { OperationsJobsService, PrefilterResult } from "./service.js";
import type { OperationAdviceRun } from "./advice-runner.js";

export interface OperationsSchedulerOptions {
  readonly service: OperationsJobsService;
  readonly merchant_id: string;
  /** 治理所有权预检；抛错即视为失权，停止调度。 */
  readonly assertOwner: () => void;
  readonly runner: (input: {
    rule: NonNullable<ReturnType<OperationsJobsService["getRule"]>>;
    task: { task_id: string; payload: Record<string, unknown> };
  }) => Promise<OperationAdviceRun>;
  readonly now: () => string;
  readonly worker_id?: string;
  readonly interval_ms?: number;
  readonly lease_ms?: number;
  readonly execution_timeout_ms?: number;
  readonly max_tasks_per_tick?: number;
  readonly prefilter?: (rule: NonNullable<ReturnType<OperationsJobsService["getRule"]>>) => PrefilterResult;
  readonly log?: (line: string) => void;
}

export interface SchedulerTickResult {
  readonly evaluations: number;
  readonly claimed: number;
  readonly committed: number;
  readonly failed: number;
  readonly stopped: boolean;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;

function isNotOwner(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "not_acquired" || code === "feature_disabled" || code === "not_owner";
}

/** 建议中的证据引用必须是任务快照里出现过的引用（防止模型编造来源）。 */
export function collectSnapshotRefs(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectSnapshotRefs(item, output);
    return output;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "string" && /ref|evidence/i.test(key)) output.add(item);
      else if (Array.isArray(item) && /ref|evidence/i.test(key)) {
        for (const entry of item) if (typeof entry === "string") output.add(entry);
      } else collectSnapshotRefs(item, output);
    }
  }
  return output;
}

export function invalidEvidenceRefs(
  adviceRefs: readonly string[],
  payload: Record<string, unknown>,
): string[] {
  const allowed = collectSnapshotRefs(payload);
  return adviceRefs.filter((ref) => !allowed.has(ref));
}

export class OperationsScheduler {
  private readonly options: OperationsSchedulerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(options: OperationsSchedulerOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.timer !== undefined && !this.stopped;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.options.log?.(
          `[operations scheduler] tick failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    }, this.options.interval_ms ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<SchedulerTickResult> {
    const result = { evaluations: 0, claimed: 0, committed: 0, failed: 0, stopped: false };
    if (this.stopped) return { ...result, stopped: true };
    try {
      this.options.assertOwner();
    } catch {
      this.stop();
      return { ...result, stopped: true };
    }
    const merchantId = this.options.merchant_id;
    const workerId = this.options.worker_id ?? `ops-scheduler:${process.pid}`;
    const prefilter =
      this.options.prefilter ??
      (() => ({
        result: "data_incomplete" as const,
        reason_code: "projection_unavailable",
        detail: { missing: "projection" },
      }));
    const evaluations = this.options.service.evaluateDue({
      merchant_id: merchantId,
      prefilter,
    });
    result.evaluations = evaluations.length;

    const maxTasks = this.options.max_tasks_per_tick ?? 5;
    for (let index = 0; index < maxTasks; index += 1) {
      try {
        this.options.assertOwner();
      } catch {
        this.stop();
        result.stopped = true;
        break;
      }
      const claimed = this.options.service.claimDue({
        merchant_id: merchantId,
        worker_id: workerId,
        lease_ms: this.options.lease_ms ?? DEFAULT_LEASE_MS,
      });
      if (claimed === undefined) break;
      result.claimed += 1;
      const rule = claimed.rule_id === null ? undefined : this.options.service.getRule(merchantId, claimed.rule_id);
      if (rule === undefined) {
        this.options.service.failClaimedTask({
          merchant_id: merchantId,
          task_id: claimed.task_id,
          worker_id: workerId,
          fencing: claimed.fencing_token,
          error_code: "rule_missing",
        });
        result.failed += 1;
        continue;
      }
      const remaining =
        claimed.deadline_at === null
          ? Number.POSITIVE_INFINITY
          : Date.parse(claimed.deadline_at) - Date.parse(this.options.now());
      if (remaining <= 0) {
        // 截止后不再发起模型调用；记失败并让退避/截止守卫处理。
        this.options.service.failClaimedTask({
          merchant_id: merchantId,
          task_id: claimed.task_id,
          worker_id: workerId,
          fencing: claimed.fencing_token,
          error_code: "deadline_exceeded",
        });
        result.failed += 1;
        continue;
      }
      const timeoutMs = Math.min(
        this.options.execution_timeout_ms ?? DEFAULT_EXECUTION_TIMEOUT_MS,
        remaining,
      );
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const adviceRun = await Promise.race([
          this.options.runner({ rule, task: { task_id: claimed.task_id, payload: claimed.payload } }),
          new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("executor_timeout")), timeoutMs);
            timeoutHandle.unref?.();
          }),
        ]);
        const invalid = invalidEvidenceRefs(adviceRun.advice.evidence_refs, claimed.payload);
        const commitInput =
          invalid.length > 0
            ? {
                result_kind: "data_issue",
                payload: {
                  reason_code: "invalid_evidence_refs",
                  invalid_refs: invalid,
                  summary: "模型建议引用了任务快照中不存在的证据，已转为数据缺证待办。",
                },
              }
            : {
                result_kind: adviceRun.advice.kind,
                payload: { advice: adviceRun.advice },
              };
        this.options.assertOwner();
        this.options.service.commitInternalResult({
          merchant_id: merchantId,
          task_id: claimed.task_id,
          worker_id: workerId,
          fencing: claimed.fencing_token,
          expected_revision: claimed.revision,
          expected_cancel_epoch: claimed.cancel_epoch,
          result_kind: commitInput.result_kind,
          payload: commitInput.payload,
          ...(invalid.length === 0
            ? { usage: { input: adviceRun.usage.input, output: adviceRun.usage.output } }
            : {}),
        });
        result.committed += 1;
      } catch (err) {
        if (isNotOwner(err)) {
          this.stop();
          result.stopped = true;
          break;
        }
        result.failed += 1;
        try {
          this.options.service.failClaimedTask({
            merchant_id: merchantId,
            task_id: claimed.task_id,
            worker_id: workerId,
            fencing: claimed.fencing_token,
            error_code: err instanceof Error ? err.message.slice(0, 100) : "executor_error",
          });
          this.options.service.retryTask({
            merchant_id: merchantId,
            task_id: claimed.task_id,
            backoff_ms: 15_000,
          });
        } catch {
          // 已达重试上限/任务已被取消：保留 FAILED，交人工核对。
        }
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    }
    return result;
  }
}
