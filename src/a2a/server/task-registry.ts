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

export class TaskRegistry {
  private readonly tasks = new Map<string, A2ATask>();

  set(taskId: string, task: A2ATask): void {
    this.tasks.set(taskId, task);
  }

  get(taskId: string): A2ATask | null {
    const task = this.tasks.get(taskId);
    return task === undefined ? null : task;
  }

  /**
   * 从 Ledger 还原任务视图：扫描事件，命中 remote_task_id === taskId 的首条
   * 记录，返回最小 A2ATask（id + status.state）。结果不依赖内存状态。
   * 未命中返回 null。
   */
  resolveFromLedger(ledger: LedgerStore, taskId: string): A2ATask | null {
    for (const negotiationId of ledger.listNegotiations()) {
      for (const event of ledger.events(negotiationId)) {
        if (event.remote_task_id !== taskId) continue;
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
