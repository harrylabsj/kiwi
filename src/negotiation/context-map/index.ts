/**
 * context-map — negotiation_id ↔ 远端 A2A contextId / taskId 持久化映射
 * （WP3，基线 §9.2 / §24.4–§24.5）。
 */

export { ContextMapError, ContextMapStore, contextMapFileName } from "./store.js";
export type { ContextMapErrorCode, ContextMapStoreOptions } from "./store.js";
export { parseContextMapping } from "./types.js";
export type { ContextMapping, ContextMappingPatch } from "./types.js";
