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
 * discovery/ucp — UCP Profile（UCP 2026-04-08 spec family，基线 §3.2 / §25 / §43）。
 *
 * WP1：UCP Profile 模型 + resolver。后续 WP3 通过 discovery/resolve.ts 集成
 * （本 WP 不改动 resolve.ts）。
 */

export { UcpError, isUcpError } from "./error.js";
export type { UcpErrorCode } from "./error.js";
export {
  computeCapabilityIntersection,
  intersectionView,
  requireCapabilitiesCompatible,
  selectRelevantCapabilities,
  validateRequiresConstraint,
} from "./intersect.js";
export type {
  ActiveCapability,
  CapabilityExclusionReason,
  CapabilityIntersectionResult,
  ExcludedCapability,
  RequiresValidationResult,
  UcpIntersectionView,
  UcpRequiresConstraint,
  UcpRequiresVersionBounds,
  UcpCapabilityWithRequires,
} from "./intersect.js";
export { validateUcpProfile } from "./validate.js";
export type { UcpRejectedEntry, UcpRejectionCode, UcpValidationResult } from "./validate.js";
export { UcpResolver, MAX_CACHE_ENTRIES, parseCacheControl, WELL_KNOWN_UCP_PATH } from "./resolver.js";
export type {
  CacheControlParse,
  UcpResolveInput,
  UcpResolveResult,
  UcpResolverOptions,
} from "./resolver.js";
export {
  buildKiwiNegotiationCapability,
  buildKiwiVendorProfile,
  KIWI_NEGOTIATION_SCHEMA_PATH,
  KIWI_NEGOTIATION_SPEC_PATH,
  KIWI_VENDOR_AUTHORITY,
  KIWI_VENDOR_CAPABILITY_NAME,
  KIWI_VENDOR_SERVICE_NAME,
} from "./vendor.js";
export type {
  KiwiVendorBuildOptions,
  KiwiVendorCapability,
  KiwiVendorProfileOptions,
} from "./vendor.js";
export {
  UCP_TRANSPORTS,
  isDnsLabel,
  isHttpsUrl,
  originHostFor,
  parseCapabilityNamespace,
  parseServiceNamespace,
  reverseDomainToAuthority,
} from "./types.js";
export type {
  UcpCapabilityDeclaration,
  UcpNamespaceParts,
  UcpProfile,
  UcpServiceDeclaration,
  UcpSigningKey,
  UcpTransport,
} from "./types.js";
