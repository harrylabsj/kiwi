/**
 * catalog-source —— ShoppingCliCatalogSource（设计 §21 仓库归属：Kiwi 侧消费端）。
 *
 * 从 shopping-cli Commerce Agent Catalog 读取 CandidateAgent；候选不是已证明的
 * 在线身份（契约 §1），升级为 CounterpartyProfile 由 AgentDiscovery.resolveViaCatalog
 * 完成。本桶只含 source 自身，集成在 ../resolve.ts。
 */

export { ShoppingCliCatalogSource } from "./source.js";
export type { CatalogSourceDeps } from "./source.js";
export { CatalogSourceError } from "./errors.js";
export type { CatalogSourceErrorCode } from "./errors.js";
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
  type HostingMode,
  type RawHostingMode,
  type VerificationStatus,
} from "./types.js";
