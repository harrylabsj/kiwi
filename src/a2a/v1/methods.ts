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
 * A2A JSON-RPC 方法名（issue 03）。
 *
 * 1.0 方法名与 0.3 legacy 不同：`SendMessage` vs `message/send`、`GetTask` vs
 * `tasks/get` 等。本文件是方法名 + v1↔legacy 映射的单一来源——声明门禁
 * （tests/a2a-version-declaration.test.ts）与双栈 client/server 都从这读取。
 */

/** A2A 1.0 方法名常量。 */
export const METHOD_SEND_MESSAGE = "SendMessage";
export const METHOD_GET_TASK = "GetTask";
export const METHOD_LIST_TASKS = "ListTasks";
export const METHOD_CANCEL_TASK = "CancelTask";
export const METHOD_SUBSCRIBE_TO_TASK = "SubscribeToTask";
/** A2A 1.0: GetExtendedAgentCard（issue 10 / TCK CARD-EXT-001）。 */
export const METHOD_GET_EXTENDED_AGENT_CARD = "GetExtendedAgentCard";
/** A2A 1.0: SendStreamingMessage（issue 10 / TCK JSONRPC-SSE-002：不支持流式 → -32004）。 */
export const METHOD_SEND_STREAMING_MESSAGE = "SendStreamingMessage";
/** A2A 1.0 push 通知配置方法（issue 10 / TCK JSONRPC-SSE-002：不支持推送 → -32003）。 */
export const METHOD_CREATE_PUSH_CONFIG = "CreateTaskPushNotificationConfig";
export const METHOD_GET_PUSH_CONFIG = "GetTaskPushNotificationConfig";
export const METHOD_LIST_PUSH_CONFIGS = "ListTaskPushNotificationConfigs";
export const METHOD_DELETE_PUSH_CONFIG = "DeleteTaskPushNotificationConfig";

/** A2A 0.3 legacy 方法名常量。 */
export const LEGACY_METHOD_SEND_MESSAGE = "message/send";
export const LEGACY_METHOD_GET_TASK = "tasks/get";

/** 1.0 → legacy 映射（1.0 方法名 → 0.3 方法名）。 */
export const V1_TO_LEGACY: Readonly<Record<string, string>> = {
  [METHOD_SEND_MESSAGE]: LEGACY_METHOD_SEND_MESSAGE,
  [METHOD_GET_TASK]: LEGACY_METHOD_GET_TASK,
};

/** legacy → 1.0 映射（0.3 方法名 → 1.0 方法名）。 */
export const LEGACY_TO_V1: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(V1_TO_LEGACY).map(([v1, legacy]) => [legacy, v1]),
);

/** 全部 1.0 方法名集合。 */
export const V1_METHODS: ReadonlySet<string> = new Set([
  METHOD_SEND_MESSAGE,
  METHOD_GET_TASK,
  METHOD_LIST_TASKS,
  METHOD_CANCEL_TASK,
  METHOD_SUBSCRIBE_TO_TASK,
  METHOD_GET_EXTENDED_AGENT_CARD,
  METHOD_SEND_STREAMING_MESSAGE,
  METHOD_CREATE_PUSH_CONFIG,
  METHOD_GET_PUSH_CONFIG,
  METHOD_LIST_PUSH_CONFIGS,
  METHOD_DELETE_PUSH_CONFIG,
]);

/** 全部 0.3 legacy 方法名集合。 */
export const LEGACY_METHODS: ReadonlySet<string> = new Set([
  LEGACY_METHOD_SEND_MESSAGE,
  LEGACY_METHOD_GET_TASK,
]);

/** 给定方法名是否为 1.0 方法。 */
export function isV1Method(method: string): boolean {
  return V1_METHODS.has(method);
}

/** 给定方法名是否为 0.3 legacy 方法。 */
export function isLegacyMethod(method: string): boolean {
  return LEGACY_METHODS.has(method);
}
