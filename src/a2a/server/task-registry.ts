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
 * 任务注册表 + Ledger 视图映射（子规范 §23 A2A Message vs Task / §24.5 taskId）。
 *
 * message/send 会生成一个 A2A Task（task_<uuidv7>），状态记在内存注册表；
 * tasks/get 优先查内存，miss 时回退到 Ledger 视图（§23 Recovery 第 4 步：
 * "retrieve current remote A2A context/task state"）—— ledger 事件携带
 * remote_task_id / task_state，即使 server 重启（内存丢失、ledger 持久）也能
 * 还原任务状态。
 */

import { uuidv7 } from "../../negotiation/domain/identifiers.js";
import { A2A_TASK_STATES } from "../client/index.js";
import type { A2ATask, A2ATaskState } from "../client/index.js";
import type { LedgerStore } from "../../negotiation/ledger/index.js";

export function newTaskId(): string {
  return `task_${uuidv7()}`;
}

export function newArtifactId(): string {
  return `art_${uuidv7()}`;
}

export function isKnownTaskState(value: unknown): value is A2ATaskState {
  return typeof value === "string" && (A2A_TASK_STATES as readonly string[]).includes(value);
}

/** 任务归属：以认证身份标识为准（匿名主体不参与私有任务）。 */
export interface TaskOwner {
  identity: string;
  identityVerified: boolean;
}

/**
 * 匿名主体判定。`NoneAuthVerifier` 给所有匿名调用者同一个常量身份
 * `"anonymous"`——如果把它当作可共享主体，任何人都能读到别人的任务
 * （T044「匿名 task 串读」）。按设计 §13.3 权限矩阵，首版对匿名主体
 * **不开放私有任务**：匿名查询任务一律拒绝（authentication_required）。
 */
export function isAnonymousOwner(owner: TaskOwner): boolean {
  return owner.identity.trim() === "" || owner.identity === "anonymous";
}

export class TaskRegistry {
  private readonly tasks = new Map<string, { task: A2ATask; owner: TaskOwner }>();

  set(taskId: string, task: A2ATask, owner: TaskOwner): void {
    this.tasks.set(taskId, { task, owner });
  }

  /** 读取：归属不符一律返回 null（不区分"不存在"与"非本人"，不泄露存在性）。 */
  get(taskId: string, owner: TaskOwner): A2ATask | null {
    if (isAnonymousOwner(owner)) return null;
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return null;
    return entry.owner.identity === owner.identity ? entry.task : null;
  }

  /** 列出**本人**任务（issue 10 / TCK CORE-LIST：ListTasks）。 */
  list(owner: TaskOwner): A2ATask[] {
    if (isAnonymousOwner(owner)) return [];
    return [...this.tasks.values()]
      .filter((entry) => entry.owner.identity === owner.identity)
      .map((entry) => entry.task);
  }

  /** 取消（issue 10 / TCK CORE-CANCEL）：非终态 → canceled；未知/非本人 →
   *  not_found（不泄露存在性）；终态 → not_cancelable。 */
  cancel(
    taskId: string,
    owner: TaskOwner,
  ): { ok: boolean; outcome: "canceled" | "not_found" | "not_cancelable" } {
    if (isAnonymousOwner(owner)) return { ok: false, outcome: "not_found" };
    const entry = this.tasks.get(taskId);
    if (entry === undefined || entry.owner.identity !== owner.identity) {
      return { ok: false, outcome: "not_found" };
    }
    const state = entry.task.status.state;
    if (state === "completed" || state === "canceled" || state === "failed") {
      return { ok: false, outcome: "not_cancelable" };
    }
    this.tasks.set(taskId, {
      task: { ...entry.task, status: { ...entry.task.status, state: "canceled" } },
      owner: entry.owner,
    });
    return { ok: true, outcome: "canceled" };
  }

  /**
   * 从 Ledger 还原任务视图：扫描事件，命中 `remote_task_id === taskId` 的
   * 首条记录，返回最小 A2ATask（id + status.state）；**同时按事件内的身份
   * 快照做归属过滤**——重启恢复不能让任务变成"谁都能读"。
   */
  resolveFromLedger(ledger: LedgerStore, taskId: string, owner: TaskOwner): A2ATask | null {
    if (isAnonymousOwner(owner)) return null;
    for (const negotiationId of ledger.listNegotiations()) {
      for (const event of ledger.events(negotiationId)) {
        if (event.remote_task_id !== taskId) continue;
        const eventSender = event.identity?.sender_identity;
        if (typeof eventSender === "string" && eventSender !== owner.identity) return null;
        const result = event.outcome.kind === "ok" ? event.outcome.result : undefined;
        const state = result === undefined ? undefined : result["task_state"];
        if (isKnownTaskState(state)) {
          return { id: taskId, status: { state } };
        }
        // 记录存在但 task_state 不可识别 → fail-closed：不猜测状态。
        return null;
      }
    }
    return null;
  }
}
