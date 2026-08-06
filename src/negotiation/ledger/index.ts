/**
 * KNP/1.0 Negotiation Ledger（基线 §22 / §23 / 子规范 §28）。
 *
 * append-only、content-addressed、hash-linked 的协商审计日志。每条事件含
 * event_digest / previous_event_digest，verifyChain 可区分断链与篡改。
 * 不保存 raw chain-of-thought 与 Vault plaintext（§22 / §28 / §36-5）。
 */
export {
  LedgerError,
  LEDGER_ERROR_CODES,
  assertNoForbiddenContent,
  computeEventDigest,
  eventContentAddressable,
  newLedgerEventId,
} from "./event.js";
export type {
  LedgerCapabilitySnapshot,
  LedgerEvent,
  LedgerEventContent,
  LedgerEventKind,
  LedgerIdentitySnapshot,
  LedgerOutcome,
  LedgerStateTransition,
  LedgerVerifyError,
  LedgerVerifyResult,
} from "./event.js";
export { LedgerStore, ledgerFileName } from "./store.js";
export type { LedgerHighWaterMark, LedgerStoreOptions } from "./store.js";
