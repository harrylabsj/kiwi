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
 * 租约与 fencing 判定（v0.2 §8.2–§8.5 / FR32）。
 *
 * 租约只能保护内部写入；外部调用仍须幂等键或可查询回执。过期执行者
 * 即使拿到旧 fencing token 也不能提交。租约超时本身不证明外部动作未
 * 发生——只有持久记录证明未进入外部调用，才可回到 READY。
 */

import { FollowUpError } from "./types.js";

export interface FencedCommitCheck {
  lease_fencing_token: number;
  current_fencing_token: number;
  lease_expires_at: string;
  now: string;
}

export function canCommitFencedWrite(input: FencedCommitCheck): boolean {
  if (
    !Number.isSafeInteger(input.lease_fencing_token) ||
    !Number.isSafeInteger(input.current_fencing_token) ||
    input.lease_fencing_token < 1 ||
    input.current_fencing_token < 1
  ) {
    throw new FollowUpError("validation", "fencing token 必须是正整数");
  }
  const expires = Date.parse(input.lease_expires_at);
  const now = Date.parse(input.now);
  if (!Number.isFinite(expires) || !Number.isFinite(now)) {
    throw new FollowUpError("validation", "租约时间必须是可解析的 RFC 3339");
  }
  return (
    input.lease_fencing_token === input.current_fencing_token && now < expires
  );
}

/**
 * 租约过期后的状态：证明未外发 → READY；否则 → UNKNOWN。
 * “证明”必须来自持久记录（尚未进入外部调用），不能来自等待超时。
 */
export function expiredLeaseOutcome(provenNotSent: boolean): "READY" | "UNKNOWN" {
  return provenNotSent ? "READY" : "UNKNOWN";
}
