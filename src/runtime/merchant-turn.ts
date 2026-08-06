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
