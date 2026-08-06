/**
 * Capability intersection 错误。无共同可协商 binding 时抛
 * `capability_incompatible`（基线 §4.6 / §32）。
 */

export class CapabilityError extends Error {
  readonly code: "capability_incompatible";
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
    this.code = "capability_incompatible";
  }
}
