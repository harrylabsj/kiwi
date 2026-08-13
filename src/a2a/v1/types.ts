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
 * A2A 1.0 域模型（issue 02）。
 *
 * 与 0.3（`src/a2a/client/types.ts`）的差异：
 * - **统一 Part**：字段存在性判别（有 `text`=Text / `data`=Data / `url`=URL /
 *   `raw`=File），**无 `kind` 字段**；`mimeType` → `mediaType`；
 * - **Role**：`ROLE_AGENT` / `ROLE_USER` 命名常量；
 * - **TaskState**：大写下划线枚举，含 1.0 新增 `REJECTED` / `AUTH_REQUIRED` /
 *   `UNSPECIFIED`（0.3 的 `unknown` 在 1.0 语义为 `UNSPECIFIED`）。
 *
 * 词表单一来源（仿照 `handoff/destination.ts` 纪律）：本文件是 v1 词表的唯一
 * 权威，编解码/双栈/TCK 全部从这里导入，不散落字符串。
 */

/**
 * A2A 1.0 Role（wire 值 = proto 枚举名，官方 SDK `@a2a-js/sdk` 如此序列化）。
 * 输入侧兼容小写 `user`/`agent`（server 归一化，见 normalizeV1Role）。
 */
export const ROLE_AGENT = "ROLE_AGENT" as const;
export const ROLE_USER = "ROLE_USER" as const;
export type A2ARole = typeof ROLE_AGENT | typeof ROLE_USER;

/**
 * A2A 1.0 TaskState（wire 值 = proto 枚举名 `TASK_STATE_*`，官方 SDK 如此）。
 * 0.3 `unknown` → 1.0 `TASK_STATE_UNSPECIFIED`。
 */
export const A2A_TASK_STATES = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_FAILED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
  "TASK_STATE_UNSPECIFIED",
] as const;
export type A2ATaskState = (typeof A2A_TASK_STATES)[number];

/** 0.3 内部小写状态 → 1.0 wire TaskState（server 出站用）。 */
export const LEGACY_TO_V1_STATE: Readonly<Record<string, string>> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
  unknown: "TASK_STATE_UNSPECIFIED",
};

/** 1.0 wire TaskState → 0.3 内部小写状态（client 入站用）。 */
export const V1_STATE_TO_LEGACY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LEGACY_TO_V1_STATE).map(([legacy, v1]) => [v1, legacy]),
);

/** A2A 1.0 统一 Part：字段存在性判别（无 `kind`）。 */
export type A2AV1Part = TextPart | DataPart | FilePart | URLPart;

/** Text Part（有 `text` 字段即判别）。 */
export interface TextPart {
  text: string;
}

/** Data Part（有 `data` 字段即判别；KNP 载荷载体，`mediaType` 可选）。 */
export interface DataPart {
  data: Record<string, unknown>;
  mediaType?: string;
}

/** File Part（有 `raw` 字段即判别；`raw` 为 base64，必须带 `mediaType`）。 */
export interface FilePart {
  raw: string;
  mediaType: string;
}

/** URL Part（有 `url` 字段即判别）。 */
export interface URLPart {
  url: string;
}

/** A2A 1.0 Message。 */
export interface A2AV1Message {
  role: A2ARole;
  parts: A2AV1Part[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

/** A2A 1.0 TaskStatus。 */
export interface A2AV1TaskStatus {
  state: A2ATaskState;
  message?: A2AV1Message;
  timestamp?: string;
}

/** A2A 1.0 Artifact。 */
export interface A2AV1Artifact {
  parts: A2AV1Part[];
  artifactId?: string;
  metadata?: Record<string, unknown>;
}

/** A2A 1.0 Task。 */
export interface A2AV1Task {
  id: string;
  status: A2AV1TaskStatus;
  artifacts?: A2AV1Artifact[];
  contextId?: string;
  metadata?: Record<string, unknown>;
}
