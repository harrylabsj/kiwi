/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { WriteApprovalCandidateStore } from "./action-candidate.js";
import type { MerchantChangePreview } from "./intelligence/types.js";

/** Public, server-enriched projection of an approval candidate. */
export function publicCandidatePreview(
  candidate: ReturnType<WriteApprovalCandidateStore["get"]>,
): MerchantChangePreview | undefined {
  if (candidate === undefined) return undefined;
  const args = candidate.arguments;
  const before = candidate.preconditions;
  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
  const patch = args.changes;
  if (patch !== null && typeof patch === "object" && !Array.isArray(patch)) {
    for (const [field, after] of Object.entries(patch as Record<string, unknown>)) {
      if (/token|secret|credential|password|floor|cost|vault|private/i.test(field)) continue;
      changes.push({ field, before: before[field], after });
    }
  }
  if (typeof args.stock === "number") changes.push({ field: "stock", before: before.stock, after: args.stock });
  if (typeof args.paused === "boolean") changes.push({ field: "paused", before: before.paused, after: args.paused });
  if (changes.length === 0) changes.push({ field: "operation", before: "not_applied", after: candidate.tool });
  return {
    candidate_id: candidate.candidate_id,
    tool: candidate.tool,
    status: candidate.status,
    risk: candidate.risk,
    expires_at: candidate.expires_at,
    stale_sensitive: true,
    changes,
  };
}
