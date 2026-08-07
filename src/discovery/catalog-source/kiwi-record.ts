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
 * kiwi-catalog CatalogAgentRecord —— /v1/agents wire 形状的 TS 投影。
 *
 * 契约来源：contracts/kiwi-catalog/1.0/agent-record.schema.json（产品文档
 * kiwi-catalog v0.3 §6/§7）。运行时校验以 ajv 编译后的 schema 为准（kiwi-schema.ts）。
 *
 * 三正交状态域（v0.3 §7，MUST NOT 坍缩为一个状态机）：
 *   - VerificationLevel：证据链级别（可降级，历史证据可审计）；
 *   - FreshnessState：profile 新鲜度 / 可达性（FRESH/STALE/UNREACHABLE）；
 *   - AdministrativeState：治理处置（ACTIVE/SUSPENDED/REJECTED 终态）。
 *
 * `normalizeCatalogAgent` 把 record 折叠成 CandidateAgent 共享候选形状（DTO 1.0），
 * 供 AgentDiscovery.resolveViaCatalog 复用同一升级路径；折叠优先级：
 *   rejected > suspended > unreachable > stale > verification_level
 * （行政处置最重，其次可达性，再其次新鲜度——与 legacy BLOCKED 状态集语义一致）。
 */

import type { DestinationType } from "../../handoff/destination.js";
import type { CandidateAgent, CatalogSearchQuery, HostingMode } from "./types.js";

/** 验证级别（v0.3 §7.1）。 */
export type VerificationLevel =
  | "discovered"
  | "profile_valid"
  | "domain_verified"
  | "agent_verified"
  | "commerce_verified";

/** 新鲜度 / 可达性（v0.3 §7.2）。 */
export type FreshnessState = "fresh" | "stale" | "unreachable";

/** 行政处置（v0.3 §7.3）。 */
export type AdministrativeState = "active" | "suspended" | "rejected";

/** kiwi-catalog agent 公开记录（public-only，完成定义 #8）。 */
export interface CatalogAgentRecord {
  readonly catalog_agent_id: string;
  readonly principal_type: "buyer" | "merchant";
  readonly merchant_id?: string;
  readonly display_name: string;
  readonly canonical_domain: string;
  readonly agent_card_url?: string;
  readonly ucp_profile_url?: string;
  readonly protocols?: Readonly<Record<string, readonly string[]>>;
  readonly capabilities?: readonly string[];
  readonly skills?: readonly CatalogSkill[];
  readonly hosting_mode: HostingMode;
  readonly handoff_destination_types?: readonly DestinationType[];
  readonly verification_level: VerificationLevel;
  readonly freshness_state: FreshnessState;
  readonly administrative_state: AdministrativeState;
  readonly last_verified_at?: string;
  readonly fresh_until?: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 公开 skill（v0.3 §6，与 DTO 1.0 CandidateSkill 同形）。 */
export interface CatalogSkill {
  readonly skill_id: string;
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

/**
 * kiwi-catalog 富搜索查询（新 API /v1/agents/search；词表单一来源）。
 * 继承共享 CatalogSearchQuery（hosting_mode 接受 canonical + legacy 别名——
 * record schema 的 hosting_mode 枚举两者都收），新增三态域过滤与
 * `handoff_destination_types`（精确 KTH destination_type 词表，禁止平行词表）。
 */
// category/region/skill 是共享 CatalogSearchQuery 的键，但 kiwi 源的
// KIWI_SEARCH_QUERY_KEYS 运行时拒绝它们（invalid_input，fail-closed）——
// 类型层必须同步排除，否则类型合法的调用在运行时炸掉。
export interface KiwiCatalogSearchQuery
  extends Omit<CatalogSearchQuery, "category" | "region" | "skill"> {
  verification_level?: VerificationLevel;
  freshness_state?: FreshnessState;
  administrative_state?: AdministrativeState;
  /** 精确匹配 KTH destination_type（禁止 supports_* 平行词表）。 */
  handoff_destination_types?: readonly DestinationType[];
}

/** 折叠优先级：行政 > 可达性 > 新鲜度 > 验证级别。 */
function foldVerificationStatus(
  level: VerificationLevel,
  freshness: FreshnessState,
  admin: AdministrativeState,
): CandidateAgent["verification"]["status"] {
  if (admin === "rejected") return "rejected";
  if (admin === "suspended") return "suspended";
  if (freshness === "unreachable") return "unreachable";
  if (freshness === "stale") return "stale";
  return level;
}

/**
 * 三态域 record → CandidateAgent DTO 1.0 共享候选形状。
 * 注意：handoff_destination_types **不进入** CandidateAgent（DTO 1.0
 * additionalProperties: false）；需要 handoff 词表的消费方走 searchRecords。
 */
export function normalizeCatalogAgent(record: CatalogAgentRecord): CandidateAgent {
  const candidate: CandidateAgent = {
    catalog_agent_id: record.catalog_agent_id,
    merchant: {
      id: record.merchant_id ?? record.catalog_agent_id,
      name: record.display_name,
      ...(record.canonical_domain !== undefined ? { domain: record.canonical_domain } : {}),
    },
    ...(record.agent_card_url !== undefined || record.ucp_profile_url !== undefined
      ? {
          discovery: {
            ...(record.agent_card_url !== undefined ? { agent_card_url: record.agent_card_url } : {}),
            ...(record.ucp_profile_url !== undefined ? { ucp_profile_url: record.ucp_profile_url } : {}),
          },
        }
      : {}),
    ...(record.protocols !== undefined
      ? { protocols: record.protocols as Record<string, string[]> }
      : {}),
    ...(record.capabilities !== undefined ? { capabilities: [...record.capabilities] } : {}),
    ...(record.skills !== undefined
      ? {
          skills: record.skills.map((s) => ({
            skill_id: s.skill_id,
            name: s.name,
            ...(s.description !== undefined ? { description: s.description } : {}),
            ...(s.tags !== undefined ? { tags: [...s.tags] } : {}),
          })),
        }
      : {}),
    verification: {
      status: foldVerificationStatus(
        record.verification_level,
        record.freshness_state,
        record.administrative_state,
      ),
      ...(record.last_verified_at !== undefined ? { last_verified_at: record.last_verified_at } : {}),
    },
    hosting: { mode: record.hosting_mode },
    contract: { name: "candidate-agent", version: "1.0" },
  };
  return candidate;
}
