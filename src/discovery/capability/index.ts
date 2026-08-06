/**
 * discovery/capability — 双方 capability intersection（基线 §3.1 / §33）。
 */

export {
  DEFAULT_BINDING_PREFERENCE,
  intersectCapabilities,
  requireCompatibleCapabilities,
} from "./intersect.js";
export type { CapabilityIntersection, IncompatibleBinding, IntersectOptions } from "./intersect.js";
export { CapabilityError } from "./error.js";
