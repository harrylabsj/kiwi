/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { AgentProfile } from "../../config/profile.js";
import type { WriteApprovalCandidateStore } from "../merchant/action-candidate.js";
import type { MerchantClient } from "../merchant/types.js";
import type { MerchantIntelligenceBackend } from "../merchant/intelligence/backend.js";

/** Server-owned context used to enrich a model-selected presentation. */
export interface PresentationContext {
  profile: AgentProfile;
  principalId: string;
  merchantClient: MerchantClient;
  intelligence?: MerchantIntelligenceBackend;
  approvals: WriteApprovalCandidateStore;
}

export interface PresentationComponent<I, O> {
  toolName: string;
  component: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  validate(input: unknown): I;
  enrich(input: I, context: PresentationContext): Promise<O>;
}

export type AnyPresentationComponent = PresentationComponent<unknown, unknown>;
