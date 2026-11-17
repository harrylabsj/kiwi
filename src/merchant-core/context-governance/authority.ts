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
 * grant 支撑的默认 ContextVersionAuthority（M1 共性控制）。
 *
 * grant 域直接读 `DataUseGrantStore`（撤销/过期即 `undefined`）；其余域
 * （data scope、技能、记忆集合、会话、配置版本、来源可用性）在后续里程碑
 * 接入各自存储，通过可选回调注入。**未注入的域按失效处理**：快照一旦绑定
 * 该域，守卫一律 stale_context——不允许"查不到就当没变"。
 */

import type { DataUseGrantStore } from "./data-use-grant.js";
import type {
  ContextVersionAuthority,
  CurrentSkillBinding,
  SourceRefCheck,
} from "./context-guard.js";

export interface GrantBackedAuthorityOptions {
  readonly grants: DataUseGrantStore;
  /** 主体绑定当前 epoch（§9.2）；undefined = 已撤销/不存在。 */
  readonly bindingEpoch?: (merchantId: string, actorId: string) => number | undefined;
  /** 数据域当前 epoch；undefined = 已封存/删除。 */
  readonly dataScopeEpoch?: (merchantId: string, scopeKey: string) => number | undefined;
  readonly skillBinding?: (
    merchantId: string,
    skillKey: string,
  ) => CurrentSkillBinding | undefined;
  readonly memorySetVersion?: (merchantId: string) => number | undefined;
  readonly conversationRevision?: (merchantId: string) => number | undefined;
  /** 配置版本；undefined = 无法核实（绑定非空 config_version 的快照将被拒绝）。 */
  readonly configVersion?: () => string | undefined;
  readonly sourceAvailable?: (merchantId: string, ref: SourceRefCheck) => boolean;
}

export function createGrantBackedAuthority(
  options: GrantBackedAuthorityOptions,
): ContextVersionAuthority {
  return {
    currentGrantEpoch: (merchantId, grantId) =>
      options.grants.currentGrantEpoch(merchantId, grantId),
    currentBindingEpoch: options.bindingEpoch ?? ((_merchantId, _actorId) => undefined),
    currentDataScopeEpoch:
      options.dataScopeEpoch ?? ((_merchantId, _scopeKey) => undefined),
    currentSkillBinding: options.skillBinding ?? ((_merchantId, _skillKey) => undefined),
    currentMemorySetVersion: options.memorySetVersion ?? ((_merchantId) => undefined),
    currentConversationRevision: options.conversationRevision ?? ((_merchantId) => undefined),
    currentConfigVersion: options.configVersion ?? (() => undefined),
    sourceAvailable: options.sourceAvailable ?? ((_merchantId, _ref) => false),
  };
}
