/** Local owner adapter over the existing persistent budget + concurrency gate. */
import { closeSync, existsSync, openSync, chmodSync } from "node:fs";
import { AiRuntimeGate } from "./gate.js";
import { SqliteDailyBudgetStore } from "./sqlite-budget-store.js";
import type { AiRuntimeConfig } from "./config.js";
import type { OwnerBudgetGate } from "./owner-session.js";

export function createOwnerBudgetGate(input: {
  /** Existing private owner directory; only new independent owner budget path. */
  dbPath: string;
  config: AiRuntimeConfig;
}): { budgetGate: OwnerBudgetGate; close(): void } {
  if (input.dbPath === ":memory:" || input.config.budget === null)
    throw new TypeError("persistent owner budget required");
  if (!existsSync(input.dbPath)) closeSync(openSync(input.dbPath, "wx", 0o600));
  chmodSync(input.dbPath, 0o600);
  const store = new SqliteDailyBudgetStore(input.dbPath);
  const gate = new AiRuntimeGate({ config: input.config, budgetStore: store });
  return {
    budgetGate: {
      async acquire({ merchantId, estimatedTokens }) {
        const decision = await gate.acquireTurnLease({ merchantId, estimatedTokens });
        if (!decision.ok) return { allowed: false, reason: decision.reason };
        if (!gate.markInFlight(decision.lease.leaseId)) {
          await gate.releaseLease(decision.lease.leaseId);
          return { allowed: false, reason: "concurrency_denied" };
        }
        return { allowed: true, leaseId: decision.lease.leaseId };
      },
      async settle({ leaseId, usedTokens }) {
        gate.confirmCallEnded(leaseId);
        const result = await gate.settleLease(leaseId, { usedTokens });
        if (result.error !== undefined) throw new Error(result.error);
      },
    },
    close() {
      store.close();
    },
  };
}
