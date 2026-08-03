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
