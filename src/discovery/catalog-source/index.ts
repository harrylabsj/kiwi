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
 * catalog-source —— ShoppingCliCatalogSource（设计 §21 仓库归属：Kiwi 侧消费端）。
 *
 * 从 shopping-cli Commerce Agent Catalog 读取 CandidateAgent；候选不是已证明的
 * 在线身份（契约 §1），升级为 CounterpartyProfile 由 AgentDiscovery.resolveViaCatalog
 * 完成。本桶只含 source 自身，集成在 ../resolve.ts。
 */

export { ShoppingCliCatalogSource } from "./source.js";
export type { CatalogSourceDeps } from "./source.js";
export { KiwiCatalogSource } from "./kiwi-source.js";
export { CatalogSourceError } from "./errors.js";
export type { CatalogSourceErrorCode } from "./errors.js";
export { validateCatalogAgentRecord, validateListingRecord, validateListingSearchResult } from "./kiwi-schema.js";
export {
  normalizeCatalogAgent,
  type AdministrativeState,
  type CatalogAgentRecord,
  type CatalogSkill,
  type FreshnessState,
  type KiwiCatalogSearchQuery,
  type KiwiListingSearchQuery,
  type ListingAgentProjection,
  type ListingFreshnessState,
  type ListingMatch,
  type ListingMerchantSummary,
  type ListingRecord,
  type ListingSearchResult,
  type ListingType,
  type PublicationState,
  type VerificationLevel,
} from "./kiwi-record.js";
export {
  normalizeHostingMode,
  type CandidateAgent,
  type CandidateContract,
  type CandidateDiscovery,
  type CandidateHosting,
  type CandidateMerchant,
  type CandidateSkill,
  type CandidateVerification,
  type CatalogSearchQuery,
  type CatalogSource,
  type HostingMode,
  type RawHostingMode,
  type VerificationStatus,
} from "./types.js";
