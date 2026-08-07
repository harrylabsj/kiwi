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
 * CandidateAgent DTO 1.0 —— 类型定义（对齐契约，字段以 schema 为准）。
 *
 * 契约来源：shopping-cli 仓 `CANDIDATE_AGENT_SCHEMA`（vendored 到
 * contracts/candidate-agent-dto-1.0.schema.json），规范文档
 * docs/a2a/candidate-agent-dto-1.0.md。Kiwi 侧 **MUST NOT** 重定义 wire 形状；
 * 本文件是 schema 的 TS 投影，运行时校验以 ajv 编译后的 schema 为准。
 *
 * 关键语义（契约 §1）：CandidateAgent 是“可发现的商品代理”，**不是**已证明的
 * 在线身份。Kiwi 必须对其做 fresh verification 才能升级为 CounterpartyProfile。
 *
 * hosting.mode（设计 §22）：canonical 值为 direct_only / hosted_only / hybrid /
 * unknown；DB 遗留值 direct / hosted 向后兼容保留，通过 normalizeHostingMode
 * 归一化为 canonical 值（无法识别的值 fail-closed 到 unknown）。
 */

/** verification.status 已知取值（契约 §4.7 / 设计 §6 state machine）。 */
export type VerificationStatus =
  | "discovered"
  | "profile_valid"
  | "domain_verified"
  | "agent_verified"
  | "commerce_verified"
  | "stale"
  | "unreachable"
  | "suspended"
  | "rejected";

/** hosting.mode 原始值（schema enum：canonical + legacy alias）。 */
export type RawHostingMode =
  "direct" | "hosted" | "hybrid" | "unknown" | "direct_only" | "hosted_only";

/** hosting.mode canonical 值（设计 §22）。 */
export type HostingMode = "direct_only" | "hosted_only" | "hybrid" | "unknown";

/** 契约注解（契约 §3）：name 恒为 candidate-agent，version 恒为 1.0（const）。 */
export interface CandidateContract {
  name: "candidate-agent";
  version: "1.0";
}

/** 公开 merchant 引用（契约 §4.2，public-only）。 */
export interface CandidateMerchant {
  id: string;
  name: string;
  city?: string;
  service_area?: string;
  domain?: string;
  tags?: string[];
}

/** 公开发现端点（契约 §4.3；internal hosted_gateway 永不出现）。 */
export interface CandidateDiscovery {
  agent_card_url?: string;
  ucp_profile_url?: string;
  a2a_urls?: string[];
}

/** 公开 skill（契约 §4.6）。 */
export interface CandidateSkill {
  skill_id: string;
  name: string;
  description?: string;
  tags?: string[];
}

/** verification 状态快照（契约 §4.7）。 */
export interface CandidateVerification {
  status: VerificationStatus;
  last_verified_at?: string;
}

/** hosting 模式快照（契约 §4.8，canonical 见 §22）。 */
export interface CandidateHosting {
  mode: RawHostingMode;
}

/**
 * CandidateAgent —— catalog 返回的候选对象（契约 1.0）。
 * 必填：catalog_agent_id / verification / hosting / contract；其余均可选。
 * 通过 ajv 校验后该对象可安全使用（schema additionalProperties: false）。
 */
export interface CandidateAgent {
  catalog_agent_id: string;
  merchant?: CandidateMerchant;
  discovery?: CandidateDiscovery;
  /** protocol 名 → 版本数组（契约 §4.4，版本串 verbatim）。 */
  protocols?: Record<string, string[]>;
  /** 全限定 capability 标识（契约 §4.5，namespace:capability_id）。 */
  capabilities?: string[];
  skills?: CandidateSkill[];
  verification: CandidateVerification;
  hosting: CandidateHosting;
  contract: CandidateContract;
}

/**
 * 归一化 hosting.mode 到 canonical 值（契约 §4.8 to_contract_hosting_mode）。
 * legacy direct → direct_only、hosted → hosted_only；其余原样。
 */
export function normalizeHostingMode(mode: RawHostingMode): HostingMode {
  switch (mode) {
    case "direct":
      return "direct_only";
    case "hosted":
      return "hosted_only";
    default:
      return mode;
  }
}

/**
 * CatalogSource 统一接口：legacy `ShoppingCliCatalogSource`（/v1/agent-catalog/*）
 * 与产品化 `KiwiCatalogSource`（/v1/agents/*）都满足；resolve.ts 的
 * resolveViaCatalog 可互换使用。返回的候选都必须是已通过契约校验的
 * CandidateAgent（DTO 1.0 形状）。
 */
export interface CatalogSource {
  searchCandidates(query: CatalogSearchQuery): Promise<CandidateAgent[]>;
  getCandidate(catalogAgentId: string): Promise<CandidateAgent>;
}

/**
 * Catalog 搜索查询（设计 §10.1 子集）。类型层约束合法键；运行时非法键抛
 * invalid_input（fail-closed，不静默丢弃）。
 */
export interface CatalogSearchQuery {
  q?: string;
  category?: string;
  region?: string;
  skill?: string;
  capability?: string;
  protocol?: string;
  /** hosting_mode：接受 canonical 或 legacy 值（§22）。 */
  hosting_mode?: RawHostingMode;
  verification_status?: VerificationStatus;
  limit?: number;
  cursor?: string;
}
