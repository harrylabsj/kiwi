/**
 * Back-compat module: the M1 merchant turn is the role-aware negotiation
 * turn (runtime/negotiation-turn.ts) driven with a merchant profile.
 * New code should import runNegotiationTurn directly.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../config/profile.js";
import type { CommerceClient } from "../commerce/types.js";
import {
  runNegotiationTurn,
  type TurnReport,
  type TurnOutcome,
  type TurnUsage,
} from "./negotiation-turn.js";

export type { TurnOutcome, TurnReport, TurnUsage };

export interface MerchantTurnOptions {
  profile: AgentProfile;
  client: CommerceClient;
  streamFn: StreamFn;
  /** Resolves the model API key for the real provider; unused for fake. */
  getApiKey?: () => string | undefined;
  /** External shutdown signal (SIGINT/SIGTERM). Aborts the Pi run. */
  signal?: AbortSignal;
}

export async function runMerchantTurn(options: MerchantTurnOptions): Promise<TurnReport> {
  return runNegotiationTurn(options);
}
