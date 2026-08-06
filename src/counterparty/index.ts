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
