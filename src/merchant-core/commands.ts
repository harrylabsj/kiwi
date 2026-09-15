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
 * 持久命令记录与执行闭环（V2 阶段三：src/merchant-core/commands.ts）。
 *
 * 命令记录复用 `WriteApprovalCandidateStore`（state.sqlite 单 owner 写；
 * 字段即命令记录：tool、arguments（含 hash）、preconditions（含 hash）、
 * risk、principal_id、expires_at、状态机
 * prepared→approved→executed / rejected / superseded / expired——store 里
 * pending_approval 即 prepared）。单次用途：executed 后不可再执行。
 *
 * 写链路时序：
 *   prepare（登记候选 + 前置版本快照 + 预览）→ 可信确认通道写入 approved
 *   （模型自报「已批准」不作证据——只能经 executeApproved 由已认证主体触发）→
 *   执行器校验（授权主体一致 / 前置版本重读重哈希 / 有效期 / 硬策略）→
 *   幂等执行（executed 后重放返回 not_approvable，绝不二次执行）→ 回读校验 →
 *   审计（store 状态流转 + content hash 即审计记录）。
 *
 * 恢复：进程重启后 recoverPending() 从命令记录恢复全部已注册工具的 pending
 * 命令——钩子由固定执行器注册表按存储的 tool/arguments 确定性重建；未注册
 * tool 的命令 fail-closed 标 expired（不展示成仍可批准）。V1 的
 * recoverPendingDrafts 语义被本机制覆盖并推广到全部写工具。
 */

import type { AgentProfile } from "../config/profile.js";
import type { AgentMode } from "../agent/mode.js";
import {
  executeApprovedCandidate,
  WriteApprovalCandidateError,
  type ApprovalExecutionResult,
  type WriteApprovalCandidate,
  type WriteApprovalCandidateStore,
} from "../agent/merchant/action-candidate.js";
import { routeWriteCandidate, type WriteGateResult } from "../agent/write-gate.js";
import { MerchantWorkbenchError } from "../merchant/workbench-service.js";
import type { ExecutorContext, MerchantExecutorRegistry } from "./executor.js";

export interface MerchantCommandLogDeps {
  store: WriteApprovalCandidateStore;
  executors: MerchantExecutorRegistry;
  executorContext: ExecutorContext;
  profile: AgentProfile;
  mode: () => AgentMode;
  now: () => string;
  /** 批准动作的调用主体（确认通道认证身份；必须等于命令记录主体）。 */
  principalId: string;
}

export interface PreparedCommand {
  candidate: WriteApprovalCandidate;
  /** 预览（具体改动对照；prepare 只产生候选与预览，不改业务状态）。 */
  preview: Record<string, unknown>;
  outcome: WriteGateResult;
}

export class MerchantCommandLog {
  private readonly deps: MerchantCommandLogDeps;

  constructor(deps: MerchantCommandLogDeps) {
    this.deps = deps;
  }

  /**
   * 登记写命令（prepare）：校验工具已注册 → 执行器重读前置版本 → 写门
   * force_pending 产候选（任何模式都不自动执行）。
   */
  async prepare(input: {
    tool: string;
    arguments: Record<string, unknown>;
    reason?: string;
  }): Promise<PreparedCommand> {
    const executor = this.deps.executors.get(input.tool);
    if (executor === undefined) {
      throw new MerchantWorkbenchError(
        "validation",
        `未注册的写工具 ${input.tool}（固定执行器注册表，禁止动态分发）`,
      );
    }
    const preconditions = await executor.readPreconditions(input.arguments);
    const args = { ...input.arguments, reason: input.reason ?? "" };
    const outcome = await routeWriteCandidate(
      {
        mode: this.deps.mode,
        approvals: this.deps.store,
        profile: this.deps.profile,
        now: this.deps.now,
      },
      {
        tool: input.tool,
        arguments: args,
        preconditions,
        risk: "write_catalog",
        // 命令一律 pending：确认通道批准后才执行（任何模式都不自动执行）。
        force_pending: true,
        execute: (approvedArgs) => executor.execute(approvedArgs, this.deps.executorContext),
        readPreconditions: () => executor.readPreconditions(input.arguments),
      },
    );
    const candidate = "candidate" in outcome ? outcome.candidate : undefined;
    if (candidate === undefined) {
      throw new MerchantWorkbenchError("unavailable", "写门未产生候选");
    }
    return {
      candidate,
      preview: {
        tool: input.tool,
        arguments: args,
        before: preconditions,
        note: "展示预览 ≠ 批准；批准 ≠ 执行成功（执行前重校验前置版本与硬策略）。",
      },
      outcome,
    };
  }

  /**
   * 批准并执行（确认通道；execute_approved 工具/管理页面调用）。
   * 授权主体一致性：调用主体必须等于命令记录主体（store 按 principal 绑定）。
   */
  async executeApproved(
    commandId: string,
    callerPrincipalId: string,
  ): Promise<ApprovalExecutionResult> {
    if (callerPrincipalId !== this.deps.principalId) {
      throw new MerchantWorkbenchError("auth", "批准主体与命令记录主体不一致（跨主体批准拒绝）");
    }
    try {
      const candidate = this.deps.store.get(commandId);
      if (candidate === undefined) {
        throw new MerchantWorkbenchError("not_found", `未知命令 ${commandId}`);
      }
      const executor = this.deps.executors.get(candidate.tool);
      if (executor === undefined) {
        // 未注册工具的命令不可执行——fail-closed 失效。
        this.deps.store.expireCandidate(commandId);
        throw new MerchantWorkbenchError(
          "validation",
          `命令 ${commandId} 的工具 ${candidate.tool} 未注册，已失效`,
        );
      }
      this.deps.store.markApproved(commandId); // 过期/非 pending → 抛错（fail-closed）
      const outcome = await executeApprovedCandidate(this.deps.store, commandId, {
        readPreconditions: () => executor.readPreconditions(candidate.arguments),
        execute: async (approvedArgs) => {
          const output = await executor.execute(approvedArgs, this.deps.executorContext);
          // 回读校验（写链路闭环）
          await executor.verifyAfter?.(approvedArgs, this.deps.executorContext);
          return output;
        },
      });
      return outcome;
    } catch (err) {
      if (err instanceof MerchantWorkbenchError) throw err;
      if (err instanceof WriteApprovalCandidateError) {
        throw new MerchantWorkbenchError(
          err.code === "not_found" ? "not_found" : "validation",
          err.message,
        );
      }
      throw new MerchantWorkbenchError(
        "unavailable",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** 拒绝候选（确认通道）。 */
  async reject(commandId: string, callerPrincipalId: string): Promise<WriteApprovalCandidate> {
    if (callerPrincipalId !== this.deps.principalId) {
      throw new MerchantWorkbenchError("auth", "拒绝主体与命令记录主体不一致");
    }
    const candidate = this.deps.store.get(commandId);
    if (candidate === undefined) {
      throw new MerchantWorkbenchError("not_found", `未知命令 ${commandId}`);
    }
    return this.deps.store.reject(commandId);
  }

  /**
   * 重启恢复：从命令记录恢复全部已注册工具的 pending 命令（钩子按存储
   * 参数经注册表确定性重建）；未注册 tool 的命令 fail-closed 标 expired。
   * 返回 { recovered, expiredUnknown }。
   */
  recoverPending(): { recovered: number; expiredUnknown: number } {
    let recovered = 0;
    let expiredUnknown = 0;
    for (const candidate of this.deps.store.listPending()) {
      if (this.deps.executors.has(candidate.tool)) {
        recovered += 1; // 钩子由注册表在执行时按存储参数重建，无需进程内闭包
      } else {
        this.deps.store.expireCandidate(candidate.candidate_id);
        expiredUnknown += 1;
      }
    }
    return { recovered, expiredUnknown };
  }

  listPending(): WriteApprovalCandidate[] {
    return this.deps.store.listPending();
  }

  get(commandId: string): WriteApprovalCandidate | undefined {
    return this.deps.store.get(commandId);
  }
}

export { WriteApprovalCandidateError };
