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
 * 接待侧客户记忆工具契约（设计 v1.1 §10 / §11 / M3-6）。
 *
 * 运行快照绑定 subject/binding_epoch/grant_versions/memory_set_version/
 * data_scope_epochs；工具只能读取当前绑定主体，不能由模型提交 subject。
 * `propose_customer_memory` 只写 candidate，确认仍由客户显式完成。
 */

import type { HistorySearchResult, MemoryNamespace, MemorySourceKind } from "../../merchant-core/customer-memory/types.js";

export interface CustomerRecallContext {
  readonly merchant_id: string;
  readonly subject_id: string;
  readonly binding_epoch: number;
  readonly resource_scope_id: string;
  /** grant_id → 当前 epoch。 */
  readonly grant_versions: Readonly<Record<string, number>>;
  readonly memory_set_version: number;
  /** erase_scope_id → data_epoch。 */
  readonly data_scope_epochs: Readonly<Record<string, number>>;
}

export interface CustomerMemoryRecallItem {
  readonly memory_id: string;
  readonly namespace: MemoryNamespace;
  readonly key: string;
  readonly value_ref: string;
  readonly value_type: string;
  readonly version: number;
  readonly confirmed_at: string | null;
}

export interface CustomerMemoryToolProvider {
  contextFor(merchantId: string, actorId: string): CustomerRecallContext | undefined;
  currentBindingEpoch(merchantId: string, actorId: string): number | undefined;
  currentGrantEpoch(merchantId: string, grantId: string): number | undefined;
  currentDataScopeEpoch(merchantId: string, scopeKey: string): number | undefined;
  currentMemorySetVersion(merchantId: string, subjectId: string): number | undefined;
  recall(context: CustomerRecallContext): CustomerMemoryRecallItem[];
  search(
    context: CustomerRecallContext,
    input: { query: string; cursor?: string; limit?: number },
  ): HistorySearchResult;
  propose(
    context: CustomerRecallContext,
    input: {
      namespace: MemoryNamespace;
      key: string;
      value_ref: string;
      value_type: string;
      source_kind: MemorySourceKind;
      confidence?: number;
    },
  ): { memory_id: string; state: string };
}
