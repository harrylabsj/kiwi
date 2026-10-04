/** Guard public Models provider requests, including recovered compaction. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { requireOwnerProvider, type OwnerStorageAdmission } from "./owner-storage-admission.js";
/** One runner owns this gate; permits are private, one request, and never model supplied. */
export function createOwnerRequestGate(input: {
  maxRequests: number;
  reservationTokens: number;
  currentSpend: () => Promise<number>;
}): () => Promise<() => void> {
  if (
    !Number.isSafeInteger(input.maxRequests) ||
    input.maxRequests < 1 ||
    !Number.isSafeInteger(input.reservationTokens) ||
    input.reservationTokens < 1
  )
    throw new Error("request_limits_invalid");
  const { maxRequests, reservationTokens, currentSpend } = input;
  let requests = 0;
  let occupied = false;
  let previousSpend: number | undefined;
  return async () => {
    if (occupied) throw new Error("request_concurrency_refused");
    if (requests >= maxRequests) throw new Error("request_budget_exhausted");
    occupied = true;
    try {
      const spend = await currentSpend();
      if (!Number.isSafeInteger(spend) || spend < 0) throw new Error("usage_unknown");
      if (spend >= reservationTokens) throw new Error("turn_budget_exhausted");
      // A completed stream can precede the SDK's usage commit. Never authorize
      // another task using that stale snapshot (zero-token progress also refuses).
      if (previousSpend !== undefined && spend <= previousSpend)
        throw new Error("usage_progress_unconfirmed");
      previousSpend = spend;
      requests += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          occupied = false;
        }
      };
    } catch (error) {
      occupied = false;
      throw error;
    }
  };
}
export function guardOwnerModels(
  models: Models,
  admission: OwnerStorageAdmission,
  checkGrant: () => void,
  acquireRequest?: () => Promise<() => void>,
): Models {
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple")
        return (...args: Parameters<Models["streamSimple"]>) => {
          checkGrant();
          const r = requireOwnerProvider(admission);
          if (args[2]?.sessionId !== r.sessionId) throw new Error("provider_option_mismatch");
          // Keep the SDK's synchronous event-stream contract. No provider call starts
          // until a private async permit succeeds. Relay actual events/result unchanged.
          const shell = createAssistantMessageEventStream();
          let started: Promise<ReturnType<Models["streamSimple"]>> | undefined;
          let release: (() => void) | undefined;
          const start = () =>
            (started ??= (async () => {
              if (acquireRequest === undefined) throw new Error("request_gate_required");
              release = await acquireRequest();
              try {
                checkGrant();
                const fresh = requireOwnerProvider(admission);
                args[2]?.signal?.throwIfAborted();
                if (args[2]?.sessionId !== fresh.sessionId)
                  throw new Error("provider_option_mismatch");
                return target.streamSimple(...args);
              } catch (error) {
                release();
                throw error;
              }
            })());
          shell[Symbol.asyncIterator] = async function* () {
            try {
              yield* await start();
            } catch (error) {
              release?.();
              throw error;
            }
          };
          shell.result = async () => {
            try {
              return await (await start()).result();
            } finally {
              release?.();
            }
          };
          return shell;
        };
      if (property === "completeSimple")
        return async (...args: Parameters<Models["completeSimple"]>) => {
          checkGrant();
          const r = requireOwnerProvider(admission);
          if (args[2]?.sessionId !== r.sessionId) throw new Error("provider_option_mismatch");
          if (acquireRequest === undefined) throw new Error("request_gate_required");
          const release = await acquireRequest();
          try {
            checkGrant();
            const fresh = requireOwnerProvider(admission);
            args[2]?.signal?.throwIfAborted();
            if (args[2]?.sessionId !== fresh.sessionId) throw new Error("provider_option_mismatch");
            return await target.completeSimple(...args);
          } finally {
            release();
          }
        };
      if (property === "fetchDeferred" || property === "cancelDeferred")
        return () => {
          throw new Error("storage_deferred_unsupported");
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
