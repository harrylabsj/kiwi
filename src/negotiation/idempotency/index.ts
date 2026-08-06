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
