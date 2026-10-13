/** Safe, retryable cleanup of resources owned by one runtime. */
import type { Server } from "node:http";

export class CleanupError extends Error {
  readonly code = "RESOURCE_CLOSE_FAILED";
  constructor(readonly failedSteps: readonly string[], causes: readonly unknown[]) {
    super("RESOURCE_CLOSE_FAILED", { cause: new AggregateError(causes, "RESOURCE_CLOSE_FAILED") });
    this.name = "CleanupError";
  }
}

/** Native DatabaseSync exposes isOpen on the supported Node line. Unknown is not closed. */
export function closeDatabase(db: { close(): void; readonly isOpen?: boolean }): void {
  try { if (db.isOpen === false) return; } catch { /* Still attempt the close. */ }
  try {
    db.close();
    if (db.isOpen !== false) throw new Error("DATABASE_RELEASE_UNCONFIRMED");
  } catch (cause) {
    let closed = false;
    try { closed = db.isOpen === false; } catch { /* Unknown must remain retryable. */ }
    if (!closed) throw new CleanupError(["database"], [cause]);
  }
}

export interface CleanupStep {
  id: string;
  run: () => void | Promise<void>;
  /** Active prerequisites must finish before dependent resource release. */
  after?: readonly string[];
}

export function createSyncCleanup(steps: readonly CleanupStep[]): () => void {
  const completed = new Set<string>();
  return () => {
    const failures: string[] = [], causes: unknown[] = [];
    for (const step of steps) {
      if (completed.has(step.id)) continue;
      if (step.after?.some((id) => !completed.has(id))) {
        failures.push(step.id); causes.push(new Error("ACTIVE_RESOURCE_HOLD")); continue;
      }
      try {
        const result = step.run();
        if (result !== undefined) throw new Error("ASYNC_RESOURCE_REQUIRES_ASYNC_CLEANUP");
        completed.add(step.id);
      } catch (cause) { failures.push(step.id); causes.push(cause); }
    }
    if (failures.length) throw new CleanupError(failures, causes);
  };
}

export function withCloseDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CleanupError(["deadline"], [new Error("CLOSE_TIMEOUT")])), timeoutMs);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (cause: unknown) => { clearTimeout(timer); reject(cause); });
  });
}

/** Successes are retained; pending timeouts are never run a second time while active. */
export function createCleanup(steps: readonly CleanupStep[], timeoutMs = 5_000): () => Promise<void> {
  const completed = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  let inFlight: Promise<void> | undefined;
  return () => {
    if (inFlight) return inFlight;
    const run = async (): Promise<void> => {
      const failures: string[] = [], causes: unknown[] = [];
      for (const step of steps) {
        if (completed.has(step.id)) continue;
        if (step.after?.some((id) => !completed.has(id))) {
          failures.push(step.id); causes.push(new Error("ACTIVE_RESOURCE_HOLD")); continue;
        }
        let work = pending.get(step.id);
        if (!work) {
          work = Promise.resolve().then(step.run).then(() => {
            completed.add(step.id); pending.delete(step.id);
          }, (cause: unknown) => { pending.delete(step.id); throw cause; });
          pending.set(step.id, work);
        }
        try { await withCloseDeadline(work, timeoutMs); }
        catch (cause) { failures.push(step.id); causes.push(cause); }
      }
      if (failures.length) throw new CleanupError(failures, causes);
    };
    inFlight = run().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

/** Both callback and forced connection closure must succeed; unknown errors are not closed. */
export function closeHttpServer(server: Pick<Server, "close" | "closeAllConnections" | "listening">): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let callbackDone = false, connectionsClosed = false;
    let callbackError: Error | undefined;
    const finish = (): void => {
      if (!callbackDone || !connectionsClosed) return;
      if (callbackError && ((callbackError as { code?: unknown }).code !== "ERR_SERVER_NOT_RUNNING" || server.listening)) {
        reject(new CleanupError(["http_server"], [callbackError]));
      } else resolve();
    };
    try {
      server.close((error?: Error) => { callbackDone = true; callbackError = error; finish(); });
      server.closeAllConnections(); connectionsClosed = true; finish();
    } catch (cause) { reject(new CleanupError(["http_server"], [cause])); }
  });
}
