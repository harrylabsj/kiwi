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
 * 事务包装原语 `inImmediateTransaction`（P2-1 刀 1；设计 v0.1 §2）。
 *
 * ## 为什么收敛到一处
 *
 * 盘点（2026-09-22）：全仓 16 处手写 `begin immediate` + try/commit/catch/rollback，
 * 大小写两派（`begin immediate` / `BEGIN IMMEDIATE`）、3 种提前退出形状（正常
 * 到底 / 早退 commit+return / 早退 rollback+return）。写法发散不是审美问题：
 * 每多一种形状，「这个早退到底提交了没有」就要重新推理一次，改一处忘一处
 * 就是原子性缺陷——本刀补掉的 2 处漏包装（onboarding 三方法、候选清扫两
 * 方法）就是这么来的。本目录（`merchant-core/storage/`）是 P2-1 原语的家，
 * 本文件是第一个。
 *
 * ## 定型
 *
 * - 小写 `begin immediate`：读取前先取写保留锁，并发写者等 busy_timeout 而
 *   不是直接 SQLITE_BUSY；
 * - `fn` 返回即 commit；抛错即 rollback 并重抛（错误类型原样，收敛不动对外
 *   错误契约）；
 * - **提前退出一律在 fn 内 return**：无写入的早退由 wrapper 提交一个空事务。
 *   commit 一个只读/零变更事务与 rollback 完全等价（无持久效果），所以原来
 *   「rollback 后正常返回」的形状也进 wrapper（如 oauth consumeCode 的并发
 *   核销早退、webauthn finalizeDecision 的 already_decided 早退）。
 *
 * ## 逃逸口规则
 *
 * 只有「主动 rollback 是业务语义本身」的调用点才允许保留手写，且必须在调用
 * 点注释原因。当前唯一逃逸口：`cloud/bootstrap.ts` 的权威存储探针——写一行、
 * 读回、**主动** ROLLBACK 不留痕：rollback 不是异常路径，而是探针的目的本身。
 */

import type { DatabaseSync } from "node:sqlite";

export function inImmediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("begin immediate");
  try {
    const result = fn();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
