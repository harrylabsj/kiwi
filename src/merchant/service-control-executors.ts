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
      execute: async (args, _context, decision) => {
        const expected = requirePositiveInteger(args["expected_revision"], "expected_revision");
        if (expected !== options.state.serviceRevision) {
          throw new Error("service control revision changed");
        }
        const readiness = await options.readiness();
        const failed = Object.entries(readiness.checks)
          .filter(([, value]) => !value.ok)
          .map(([name]) => name);
        // committed decision 的 operationId 与状态迁移同一个 UPDATE 落库（对账反查用）
        return options.state.resume(
          readiness.ready,
          failed,
          decision?.kind === "committed" ? decision.operationId : undefined,
        );
      },
      /**
       * 对账适配器：写后不确定时查**我们自己的**权威行——服务恢复是 kiwi 内部写，
       * 没有下游服务可问。`resume_operation_id` 与状态迁移同一个 UPDATE 提交，
       * 状态为 OPERATING 且引用等于本次 operationId 即成功。没有这个适配器时
       * `MerchantCommandLog.reconcile` 会返回 unknown +「no downstream operation
       * query adapter」，把一次可自动判定的对账变成人工升级。
       */
      queryOutcome: async (
        _args,
        _ctx,
        decision: { operationId: string },
      ): Promise<{ status: "succeeded" } | { status: "unknown"; error: string }> =>
        options.state.state === "OPERATING" &&
        options.state.lastResumeOperationId === decision.operationId
          ? { status: "succeeded" }
          : { status: "unknown", error: "service resume receipt does not match" },
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
