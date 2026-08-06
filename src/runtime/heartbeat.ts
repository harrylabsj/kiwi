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
 * Claim heartbeat (M3 reliability).
 *
 * While a claimed message is being processed by the model loop, the runtime
 * periodically refreshes the claim's updated_at on the gateway so a healthy
 * long turn is never considered stale. Discipline:
 *
 * - heartbeats never overlap: a beat is skipped while the previous one is
 *   still in flight;
 * - failures are counted, never thrown: a heartbeat problem must not fail
 *   the turn (the authoritative gate still sees every real write);
 * - stop() clears the timer and awaits the in-flight beat, so no timer or
 *   request outlives the turn.
 */

import type { CommerceClient } from "../commerce/types.js";

export interface ClaimHeartbeat {
  beats(): number;
  failures(): number;
  stop(): Promise<void>;
}

export function startClaimHeartbeat(
  client: CommerceClient,
  messageId: number,
  intervalMs: number,
): ClaimHeartbeat {
  let beats = 0;
  let failures = 0;
  let stopped = false;
  let inflight: Promise<void> | undefined;

  const beat = (): void => {
    if (stopped || inflight !== undefined) return; // never overlap
    inflight = client
      .heartbeat({ message_id: messageId })
      .then(() => {
        beats += 1;
      })
      .catch(() => {
        failures += 1; // transient heartbeat failure: keep the turn running
      })
      .finally(() => {
        inflight = undefined;
      });
  };

  const timer = setInterval(beat, intervalMs);
  // The heartbeat must never keep the process alive on its own.
  timer.unref();

  return {
    beats: () => beats,
    failures: () => failures,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inflight;
    },
  };
}
