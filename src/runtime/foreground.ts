/**
 * Foreground polling loop (design §12.2).
 *
 * Serially runs negotiation turns for one profile — the same profile never
 * runs two turns concurrently. no_work waits poll_interval_seconds;
 * transient errors back off exponentially with a bounded cap and the loop
 * continues. SIGINT/SIGTERM (an AbortSignal) aborts the in-flight turn —
 * the turn itself settles its claim (abandon, never complete) — and the
 * loop then exits cleanly.
 *
 * The loop never logs secrets or private policy values: turn reports carry
 * only public policy reasons and usage counters.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../config/profile.js";
import { CommerceError, type CommerceClient } from "../commerce/types.js";
import { runNegotiationTurn, type TurnReport } from "./negotiation-turn.js";

/** Upper bound for the transient-error backoff (ms). */
export const MAX_BACKOFF_MS = 60_000;

export type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Default sleeper: resolves early (without throwing) when aborted. */
export const defaultSleeper: Sleeper = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface ForegroundOptions {
  profile: AgentProfile;
  client: CommerceClient;
  streamFn: StreamFn;
  getApiKey?: () => string | undefined;
  /** External shutdown signal (SIGINT/SIGTERM). */
  signal?: AbortSignal;
  /** Injectable sleeper for tests; defaults to real timers. */
  sleep?: Sleeper;
  /** Called with each finished turn report (CLI writes JSONL here). */
  onReport?: (report: TurnReport) => void;
  /** Optional bound on turns, for tests and smoke runs. */
  maxTurns?: number;
}

export interface ForegroundResult {
  turns: number;
  stopped_by: "signal" | "max_turns";
}

function isTransientCommerceError(err: unknown): boolean {
  return err instanceof CommerceError && (err.kind === "transient" || err.kind === "rate_limit");
}

/** Outcomes that are worth an immediate follow-up poll. */
function needsBackoff(report: TurnReport): boolean {
  const k = report.outcome.kind;
  return k === "timeout" || k === "no_decision" || (k === "failed" && report.outcome.retriable);
}

export async function runForeground(options: ForegroundOptions): Promise<ForegroundResult> {
  const { profile, client, streamFn } = options;
  const sleep = options.sleep ?? defaultSleeper;
  const signal = options.signal;
  const pollMs = profile.runtime.poll_interval_seconds * 1000;

  let turns = 0;
  let consecutiveTransient = 0;

  for (;;) {
    if (signal?.aborted) return { turns, stopped_by: "signal" };
    if (options.maxTurns !== undefined && turns >= options.maxTurns) {
      return { turns, stopped_by: "max_turns" };
    }

    let report: TurnReport;
    try {
      report = await runNegotiationTurn({
        profile,
        client,
        streamFn,
        ...(options.getApiKey !== undefined ? { getApiKey: options.getApiKey } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      if (isTransientCommerceError(err)) {
        // Bounded exponential backoff; the loop keeps going.
        consecutiveTransient += 1;
        const backoff = Math.min(MAX_BACKOFF_MS, pollMs * 2 ** (consecutiveTransient - 1));
        await sleep(backoff, signal);
        continue;
      }
      throw err;
    }

    turns += 1;
    options.onReport?.(report);

    if (report.outcome.kind === "aborted" || signal?.aborted) {
      return { turns, stopped_by: "signal" };
    }

    if (report.outcome.kind === "no_work" || report.outcome.kind === "already_claimed") {
      consecutiveTransient = 0;
      await sleep(pollMs, signal);
      continue;
    }
    if (needsBackoff(report)) {
      consecutiveTransient += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, pollMs * 2 ** (consecutiveTransient - 1));
      await sleep(backoff, signal);
      continue;
    }
    // accepted / human_required: poll again immediately for follow-up work.
    consecutiveTransient = 0;
  }
}
