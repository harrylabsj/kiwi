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
 * 跟进任务重试预算（v0.2 §8.5 / FR35）。
 *
 * 第 n 次重试延迟 = min(max_delay, base_delay × 2^(n−1))；来源给出
 * Retry-After 时优先遵守（不被本地 max_delay 截断——来源限额优先）。
 * 达到上限或不可重试即停在 FAILED，转人工。
 */

import { FollowUpError } from "./types.js";

export interface FollowUpRetryPolicy {
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
}

export function validateRetryPolicy(policy: FollowUpRetryPolicy): FollowUpRetryPolicy {
  if (!Number.isSafeInteger(policy.max_attempts) || policy.max_attempts < 1 || policy.max_attempts > 100) {
    throw new FollowUpError("validation", "max_attempts 必须是 [1,100] 内的整数");
  }
  if (!Number.isSafeInteger(policy.base_delay_ms) || policy.base_delay_ms < 0) {
    throw new FollowUpError("validation", "base_delay_ms 必须是非负整数");
  }
  if (!Number.isSafeInteger(policy.max_delay_ms) || policy.max_delay_ms < policy.base_delay_ms) {
    throw new FollowUpError("validation", "max_delay_ms 必须 ≥ base_delay_ms");
  }
  return policy;
}

export function canRetry(policy: FollowUpRetryPolicy, attemptsSoFar: number): boolean {
  validateRetryPolicy(policy);
  if (!Number.isSafeInteger(attemptsSoFar) || attemptsSoFar < 0) {
    throw new FollowUpError("validation", "attempts_so_far 必须是非负整数");
  }
  return attemptsSoFar < policy.max_attempts;
}

/**
 * 第 retryNumber 次重试的等待时间（retryNumber 从 1 开始）。
 * 有来源 Retry-After 时直接采用；否则指数退避并受 max_delay 限制。
 */
export function nextRetryDelayMs(
  policy: FollowUpRetryPolicy,
  retryNumber: number,
  retryAfterMs?: number,
): number {
  validateRetryPolicy(policy);
  if (!Number.isSafeInteger(retryNumber) || retryNumber < 1 || retryNumber > 52) {
    throw new FollowUpError("validation", "retry_number 必须是 [1,52] 内的整数");
  }
  if (retryAfterMs !== undefined) {
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
      throw new FollowUpError("validation", "retry_after_ms 必须是非负整数");
    }
    return retryAfterMs;
  }
  const exponential = policy.base_delay_ms * 2 ** (retryNumber - 1);
  return Math.min(policy.max_delay_ms, exponential);
}
