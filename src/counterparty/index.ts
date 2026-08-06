/**
 * counterparty — CounterpartyChannel 唯一接口 + 三个实现（基线 §5 / §33 / §38）。
 */

export {
  CHANNEL_ERROR_CODES,
  ChannelError,
  isStableTaskState,
  selectChannelCandidate,
} from "./channel.js";
export type {
  ChannelCandidate,
  ChannelErrorCode,
  ChannelEventHandler,
  ChannelHandle,
  ChannelKind,
  ChannelOpenInput,
  ChannelSendInput,
  ChannelSendResult,
  CounterpartyChannel,
  CounterpartyProfile,
  RemoteEvent,
  RemoteEventKind,
  RemoteRef,
  RemoteState,
  Unsubscribe,
} from "./channel.js";

export { A2ADirectChannel } from "./a2a-direct/index.js";
export type { A2ADirectChannelOptions } from "./a2a-direct/index.js";

export { ShoppingCliHostedChannel } from "./shopping-cli-hosted/index.js";
export type { ShoppingCliHostedChannelOptions } from "./shopping-cli-hosted/index.js";

export { PlatformApiChannel } from "./platform-api/index.js";
export type { PlatformApiChannelOptions } from "./platform-api/index.js";

export { openChannel } from "./registry.js";
export type { ChannelRuntimeDeps } from "./registry.js";
