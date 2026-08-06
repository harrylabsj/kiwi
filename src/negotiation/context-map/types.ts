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
 * negotiation_id ↔ 远端 A2A context 映射模型（基线 §9.2 / 子规范 §6.6–§6.7）。
 *
 * Kiwi 持久化：
 *
 * ```text
 * negotiation_id ↔ remote contextId（可含 taskId 列表）
 * ```
 *
 * 边界（§9.2 / §24.4 / §24.5）：
 * - `remote_context_id` 对 Kiwi 完全 opaque —— 只做结构校验（validateContextId），
 *   不解析、不推断其含义；后续交互复用同一 contextId。
 * - `task_ids` 是同一 negotiation 用过的 A2A taskId 列表；taskId 只是
 *   transport/session 状态，不得替代 negotiation_id（§9.5）。
 * - 校验 fail-closed：任何字段不符合 opaque 标识符规则即拒绝。
 */

import { requireIsoTimestamp } from "../domain/common.js";
import { validateContextId, validateIdentifier, validateTaskId } from "../domain/identifiers.js";

export interface ContextMapping {
  negotiation_id: string;
  /** 远端 A2A contextId（opaque，§9.2）。 */
  remote_context_id?: string;
  /** 本 negotiation 用过的 A2A taskId 列表（§9.5，非 negotiation_id 替代）。 */
  task_ids: string[];
  updated_at: string;
}

/** 增量更新：只更新提供的字段；task_ids 通过 addTask 追加。 */
export interface ContextMappingPatch {
  remote_context_id?: string;
}

/** 从磁盘解析一条映射（untrusted）。任何字段违规 → 抛 NegotiationValidationError。 */
export function parseContextMapping(value: unknown): ContextMapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("context mapping must be an object");
  }
  const obj = value as Record<string, unknown>;
  const negotiationId = validateIdentifier(obj.negotiation_id, "negotiation_id");
  const mapping: ContextMapping = {
    negotiation_id: negotiationId,
    task_ids: [],
    updated_at: requireIsoTimestamp(obj.updated_at, "updated_at"),
  };
  if (obj.remote_context_id !== undefined) {
    mapping.remote_context_id = validateContextId(obj.remote_context_id, "remote_context_id");
  }
  if (obj.task_ids !== undefined) {
    if (!Array.isArray(obj.task_ids)) {
      throw new Error("context mapping task_ids must be an array");
    }
    mapping.task_ids = obj.task_ids.map((id, i) => validateTaskId(id, `task_ids/${i}`));
  }
  return mapping;
}
