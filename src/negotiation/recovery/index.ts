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
 * recovery — 跨进程 context 恢复（基线 §23 / 子规范 §27）。
 *
 * WP4 收敛：对端访问面统一走 src/counterparty 的 CounterpartyChannel 接口；
 * recovery 不再定义第二套 RemoteTaskGateway 契约。
 */

export {
  collectOutbound,
  deriveLocalPhase,
  deriveSessionIdentity,
  NegotiationRecovery,
  RECOVERY_SENDER_IDENTITY,
} from "./recover.js";
export { recordOutboundMessage } from "./outbound.js";
export type { OutboundMessageInput } from "./outbound.js";
export type {
  ChannelOpener,
  CounterpartyResolver,
  RecoveryDeps,
  RecoveryResult,
  RecoveryStatus,
  RemoteViewMessageIds,
} from "./types.js";

export type {
  ChannelHandle,
  ChannelOpenInput,
  CounterpartyProfile,
  RemoteState,
} from "../../counterparty/index.js";
