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
