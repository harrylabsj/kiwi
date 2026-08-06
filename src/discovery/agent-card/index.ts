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
 * discovery/agent-card — A2A Agent Card 模型（基线 §26）。
 *
 * 使用路径：先 validateAgentCard 做结构校验，再 assertNoAgentCardSecrets /
 * scanAgentCardSecrets 做 secret 扫描（不变量 24）。parseAgentCard 是两者的组合。
 */

import { assertNoAgentCardSecrets } from "./secrets.js";
import { validateAgentCard } from "./validate.js";
import type { AgentCard } from "./types.js";

export type {
  AgentCapabilities,
  AgentCard,
  AgentExtension,
  AgentInterface,
  AgentProvider,
  AgentSecurityRequirement,
  AgentSecurityScheme,
  AgentSkill,
  CoreProtocolBinding,
} from "./types.js";
export {
  CORE_PROTOCOL_BINDINGS,
  KIWI_NEGOTIATION_EXTENSION_PATH,
  isCoreProtocolBinding,
} from "./types.js";
export type { AgentCardErrorCode } from "./error.js";
export { AgentCardError, schemaError } from "./error.js";
export { isAgentCardError, validateAgentCard } from "./validate.js";
export { findNegotiationExtensions, isNegotiationExtensionUri } from "./extensions.js";
export { assertNoAgentCardSecrets, scanAgentCardSecrets } from "./secrets.js";
export type { SecretFinding, SecretKind, SecretScanResult } from "./secrets.js";

/**
 * 结构校验 + secret 扫描的组合入口。任何一步失败都抛 AgentCardError。
 * 传入原始（未类型化）card，确保扩展/未知字段也在扫描范围内。
 */
export function parseAgentCard(value: unknown): AgentCard {
  const card = validateAgentCard(value);
  assertNoAgentCardSecrets(value);
  return card;
}
