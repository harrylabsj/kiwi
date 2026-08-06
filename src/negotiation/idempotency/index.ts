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
 * 协议级幂等（基线 §17 / 子规范 §20 Idempotency and Replay）。
 *
 * 主键 (sender_identity, message_id)；同 id 同 digest 重放返回原结果，
 * 同 id 异 digest 抛 idempotency_conflict（fail-closed）。retention 至少覆盖
 * max(offer validity, task lifetime, 24h)。判定证据落 Ledger。
 */
export {
  IDEMPOTENCY_FLOOR_MS,
  IdempotencyConflictError,
  computeRetentionDeadline,
  idempotencyKey,
} from "./types.js";
export type {
  IdempotencyCheckInput,
  IdempotencyCommitInput,
  IdempotencyDecision,
  IdempotencyRecord,
  RetentionInput,
} from "./types.js";
export { IdempotencyStore } from "./store.js";
export type { IdempotencyStoreOptions } from "./store.js";
