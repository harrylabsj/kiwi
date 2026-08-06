/**
 * discovery — AgentDiscovery（§33）：Agent Card 拉取/校验 + capability
 * intersection + identity bootstrap + channel candidates。
 */

export { AgentDiscovery, DiscoveryError } from "./resolve.js";
export type {
  CatalogDiscoveryDeps,
  DiscoveryDeps,
  DiscoveryErrorCode,
  DiscoveryInput,
  ResolvedCatalogCandidate,
  UcpDiscoveryDeps,
} from "./resolve.js";

export * from "./agent-card/index.js";
export * from "./capability/index.js";
export * from "./catalog-source/index.js";
export * from "./ucp/index.js";
