/** Owner-only committed execution for restoring service availability. */

import type { MutableServiceState } from "../http/merchant-management/service-state.js";
import type { CommandExecutor } from "../merchant-core/executor.js";

export const SERVICE_CONTROL_TOOLS = {
  resume: "kiwi_workbench_service_resume",
} as const;

export function createServiceControlExecutors(options: {
  state: MutableServiceState;
  readiness: () => Promise<{ ready: boolean; checks: Record<string, { ok: boolean }> }>;
}): CommandExecutor[] {
  return [
    {
      tool: SERVICE_CONTROL_TOOLS.resume,
      risk: "service_resume",
      requiresCommittedDecision: true,
      readPreconditions: async () => ({
        state: options.state.state,
        revision: options.state.serviceRevision,
      }),
      execute: async (args) => {
        const expected = requirePositiveInteger(args["expected_revision"], "expected_revision");
        if (expected !== options.state.serviceRevision) {
          throw new Error("service control revision changed");
        }
        const readiness = await options.readiness();
        const failed = Object.entries(readiness.checks)
          .filter(([, value]) => !value.ok)
          .map(([name]) => name);
        return options.state.resume(readiness.ready, failed);
      },
      verifyAfter: async () => {
        if (options.state.state !== "OPERATING") {
          throw new Error("service resume readback failed");
        }
      },
    },
  ];
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(value);
}
