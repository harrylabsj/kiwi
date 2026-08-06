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
