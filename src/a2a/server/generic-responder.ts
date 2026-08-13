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
 * 通用 A2A 消息响应器（issue 10 / TCK）。
 *
 * 处理不带 KNP envelope 的普通 A2A 1.0 消息（SendMessage）：无磋商管线语义，
 * 按官方参考实现契约响应。响应器可注入——产品缺省是 spec 一致的回显
 * （完成任务 + 回显 parts 为 artifact + 生成 contextId）；TCK 参考场景
 * （messageId 前缀路由：complete-task / input-required / artifact-* /
 * message-response）由 conformance 层注入，不进入产品默认路径。
 *
 * 不变量：本模块只产出 1.0 wire 形状（ROLE_AGENT + 统一 Part），不做 0.3
 * 建模；状态用 legacy 内部名（completed / input-required），由 server 的
 * upperTaskState 上抛为 TASK_STATE_*。
 */

import { uuidv7 } from "../../negotiation/domain/identifiers.js";
import { newArtifactId } from "./task-registry.js";

/** 通用响应器产出的任务形状（legacy 内部状态名）。 */
export interface GenericResponderTask {
  state: "working" | "completed" | "input-required";
  contextId?: string;
  artifacts?: Array<{ artifactId: string; parts: unknown[] }>;
  /** 任务状态里的回显消息（1.0 wire：ROLE_AGENT + 统一 Part）。 */
  statusMessage?: Record<string, unknown>;
}

/** 通用消息响应：二选一——返回 Task 或直接返回 Message。 */
export interface GenericMessageResponse {
  task?: GenericResponderTask;
  message?: Record<string, unknown>;
}

export interface GenericResponderInput {
  /** 原始 1.0 消息（parts 为统一 Part wire 形状）。 */
  message: Record<string, unknown>;
  /** server 为本消息生成的任务 id。 */
  taskId: string;
  /** server 生成（或消息自带）的 contextId。 */
  contextId: string;
  now: () => string;
}

export type GenericMessageResponder = (input: GenericResponderInput) => GenericMessageResponse;

/** 生成新的 contextId（A2A 不透明字符串，ctx_<uuidv7>）。 */
export function newGenericContextId(): string {
  return `ctx_${uuidv7()}`;
}

/**
 * 默认响应器：spec 一致的回显。完成任务，把输入 parts 原样作为 text artifact
 * 回显（空 parts 则无 artifact），statusMessage 带 ROLE_AGENT 回显。
 */
export const defaultGenericResponder: GenericMessageResponder = (input): GenericMessageResponse => {
  const parts = Array.isArray(input.message.parts) ? (input.message.parts as unknown[]) : [];
  const statusMessage: Record<string, unknown> = {
    role: "ROLE_AGENT",
    parts,
    messageId: `msg_${uuidv7()}`,
  };
  return {
    task: {
      state: "completed",
      contextId: input.contextId,
      artifacts:
        parts.length > 0
          ? [{ artifactId: newArtifactId(), parts }]
          : undefined,
      statusMessage,
    },
  };
};
