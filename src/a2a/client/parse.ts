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
 * A2A 响应解析：把 JSON-RPC result 解析为结构化 A2ATask。
 *
 * fail-closed：对象形状、字段类型、Task 状态枚举、Part kind 均严格校验；
 * 未知 Part kind（如未建模的 file part）与未知 Task state 一律拒绝
 * （§4.6 unknown/畸形响应不得产生新的商业承诺）。
 */

import { A2AClientError } from "./error.js";
import { V1_STATE_TO_LEGACY } from "../v1/types.js";
import {
  A2A_TASK_STATES,
  type A2AArtifact,
  type A2AMessage,
  type A2APart,
  type A2ATask,
} from "./types.js";

function schemaInvalid(detail: string): A2AClientError {
  return new A2AClientError("schema_invalid", `A2A response schema invalid: ${detail}`);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw schemaInvalid(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw schemaInvalid(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireObject(value, path);
}

function parsePart(value: unknown, path: string): A2APart {
  const obj = requireObject(value, path);
  const kind = requireNonEmptyString(obj.kind, `${path}/kind`);
  if (kind === "text") {
    const text = obj.text;
    if (typeof text !== "string") throw schemaInvalid(`${path}/text must be a string`);
    return { kind: "text", text };
  }
  if (kind === "data") {
    return { kind: "data", data: requireObject(obj.data, `${path}/data`) };
  }
  throw schemaInvalid(`${path}/kind is unsupported: ${kind}`);
}

function parseParts(value: unknown, path: string): A2APart[] {
  if (!Array.isArray(value)) throw schemaInvalid(`${path} must be an array`);
  if (value.length === 0) throw schemaInvalid(`${path} must not be empty`);
  return value.map((part, index) => parsePart(part, `${path}/${index}`));
}

function parseMessage(value: unknown, path: string): A2AMessage {
  const obj = requireObject(value, path);
  const role = obj.role;
  if (role !== "agent" && role !== "user") {
    throw schemaInvalid(`${path}/role must be agent or user`);
  }
  const message: A2AMessage = {
    role,
    parts: parseParts(obj.parts, `${path}/parts`),
    messageId: requireNonEmptyString(obj.messageId, `${path}/messageId`),
  };
  if (obj.taskId !== undefined)
    message.taskId = requireNonEmptyString(obj.taskId, `${path}/taskId`);
  if (obj.contextId !== undefined) {
    message.contextId = requireNonEmptyString(obj.contextId, `${path}/contextId`);
  }
  const metadata = optionalRecord(obj.metadata, `${path}/metadata`);
  if (metadata !== undefined) message.metadata = metadata;
  return message;
}

function parseArtifact(value: unknown, path: string): A2AArtifact {
  const obj = requireObject(value, path);
  const artifact: A2AArtifact = { parts: parseParts(obj.parts, `${path}/parts`) };
  if (obj.artifactId !== undefined) {
    artifact.artifactId = requireNonEmptyString(obj.artifactId, `${path}/artifactId`);
  }
  const metadata = optionalRecord(obj.metadata, `${path}/metadata`);
  if (metadata !== undefined) artifact.metadata = metadata;
  return artifact;
}

function parseTask(value: unknown, path: string): A2ATask {
  const obj = requireObject(value, path);
  const task: A2ATask = {
    id: requireNonEmptyString(obj.id, `${path}/id`),
    status: (() => {
      const status = requireObject(obj.status, `${path}/status`);
      const state = requireNonEmptyString(status.state, `${path}/status/state`);
      // issue 06/10：接受 1.0 wire 状态（TASK_STATE_COMPLETED 等）与大小写变体，
      // 归一化到 0.3 小写；`UNSPECIFIED`/`TASK_STATE_UNSPECIFIED` → `unknown`。
      const normalized = V1_STATE_TO_LEGACY[state] ?? state.toLowerCase();
      if (!(A2A_TASK_STATES as readonly string[]).includes(normalized)) {
        throw schemaInvalid(`${path}/status/state is unsupported: ${state}`);
      }
      const parsed: A2ATask["status"] = { state: normalized as A2ATask["status"]["state"] };
      if (status.message !== undefined) {
        parsed.message = parseMessage(status.message, `${path}/status/message`);
      }
      if (status.timestamp !== undefined) {
        parsed.timestamp = requireNonEmptyString(status.timestamp, `${path}/status/timestamp`);
      }
      return parsed;
    })(),
  };
  if (obj.artifacts !== undefined) {
    if (!Array.isArray(obj.artifacts)) throw schemaInvalid(`${path}/artifacts must be an array`);
    task.artifacts = obj.artifacts.map((artifact, index) =>
      parseArtifact(artifact, `${path}/artifacts/${index}`),
    );
  }
  if (obj.contextId !== undefined) {
    task.contextId = requireNonEmptyString(obj.contextId, `${path}/contextId`);
  }
  const metadata = optionalRecord(obj.metadata, `${path}/metadata`);
  if (metadata !== undefined) task.metadata = metadata;
  return task;
}

/** 解析 `message/send` / `tasks/get` 的 result：必须是 `{ task: A2ATask }`。 */
export function parseTaskResult(result: unknown): A2ATask {
  const root = requireObject(result, "result");
  return parseTask(root.task, "result/task");
}
