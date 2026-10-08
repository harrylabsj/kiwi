/** Internal read budget: one timer and parent cancellation through body cleanup. */
export interface ReadRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export function createRequestBudget(defaultMs: number, options: ReadRequestOptions = {}) {
  const timeoutMs = Math.min(defaultMs, options.timeoutMs ?? defaultMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("request timeoutMs must be positive and finite");
  const controller = new AbortController();
  const parent = options.signal;
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("request deadline exceeded")),
    timeoutMs,
  );
  return {
    controller,
    timeoutMs,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}
/** Stops waiting for non-cancellable work; callers must not start I/O afterwards.
 * This does not claim to physically cancel an OS DNS resolver. */
export async function awaitWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => {});
    signal.throwIfAborted();
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("request aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Best-effort synchronous response cleanup. Abort physical fetch I/O before
 * dropping its deadline; cancellation may reject or never settle in a custom
 * transport, so neither await it nor let it replace the request's real result. */
export function finishRequestResponse(
  response: Response | undefined,
  controller: AbortController,
): void {
  try {
    controller.abort();
  } catch {
    /* cleanup cannot replace the original outcome */
  }
  try {
    void response?.body?.cancel().catch(() => {});
  } catch {
    /* body may be locked */
  }
}
