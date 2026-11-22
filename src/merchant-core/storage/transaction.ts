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
 * 就是原子性缺陷。本目录（`merchant-core/storage/`）是 P2-1 原语的家。
 *
 * ## 定型
 *
 * - 小写 `begin immediate`：读取前先取写保留锁，并发写者等 busy_timeout 而
 *   不是直接 SQLITE_BUSY；
 * - `fn` 返回即 commit；抛错即 rollback 并重抛（错误类型原样，收敛不动对外
 *   错误契约）；
 * - **提前退出一律在 fn 内 return**：无写入的早退由 wrapper 提交一个空事务；
 * - **嵌套**：显式 SAVEPOINT（见 runSavepoint）——内层失败只回滚到自己的
 *   进入点，被外层捕获继续时不提交部分写入；
 * - **自动回滚恢复**：`RAISE(ROLLBACK)` 触发器 / `INSERT OR ROLLBACK` 冲突
 *   会让 SQLite 连整个事务一起回滚。探针与 poison（见下）保证：自动回滚被
 *   wrapper 观察到之后，当前边界内的一切 wrapper 写入被拒绝（零残留），
 *   原始错误不被次生错误掩盖。
 *
 * ## 实质边界（不声称全路径零残留）
 *
 * 以上保证只覆盖"经 wrapper 的写入"。两类未被 wrapper 观察到的自动回滚
 * wrapper 无法拦截：(1) fn 吞掉自动回滚错误后直接执行的裸写（会在 autocommit
 * 中逐条提交）；(2) 手工边界内未被观察的死亡且所有者未调用
 * `markTransactionAborted`（死亡与干净结束不可区分，结束后的 wrapper 调用
 * 按全新事务执行）。纪律：事务内的业务写必须经 repository/wrapper；手工
 * BEGIN 边界的所有者另见 `markTransactionAborted` / `endTransactionBoundary`。
 *
 * ## 逃逸口规则
 *
 * 只有「主动 rollback 是业务语义本身」的调用点才允许保留手写，且必须在调用
 * 点注释原因。当前唯一逃逸口：`cloud/bootstrap.ts` 的权威存储探针——写一行、
 * 读回、**主动** ROLLBACK 不留痕：rollback 不是异常路径，而是探针的目的本身。
 * 手工 BEGIN/COMMIT 边界（不经 wrapper 的 BEGIN）若会调用本 wrapper，见
 * `endTransactionBoundary` 的登记/解除契约。
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * 连接上的 wrapper 记账：depth = 当前事务上下文层数；kind = 最外层边界的
 * 归属（wrapper 自有 / 手工 BEGIN）。手工边界在首次 wrapper 接触时登记；
 * 没有 isTransaction 的连接使用只读探测。
 */
const txDepth = new WeakMap<DatabaseSync, number>();
const txBoundaryKind = new WeakMap<DatabaseSync, "wrapper" | "manual">();
const txPoisoned = new WeakSet<DatabaseSync>();
const txUncertain = new WeakSet<DatabaseSync>();
let savepointSeq = 0;

/**
 * 连接的事务已被 SQLite 自动回滚（触发器 `RAISE(ROLLBACK)`、`INSERT OR
 * ROLLBACK` 冲突、语句级致命错误等）后，事务边界已不存在：此后任何写入都会
 * 以 autocommit 逐条提交——外层若捕获内层错误继续写，就会产生"部分提交"。
 * 当前 wrapper 上下文内拒绝一切新写入（零残留），直到边界结束；错误保留
 * 原始信息不被次生错误掩盖。`cause` 保留清理失败时可获得的底层证据
 * （如 "no such savepoint"），便于审计定位。
 */
export class TransactionAutoRolledBackError extends Error {
  constructor(cause?: unknown) {
    super(
      "kiwi-tx: 事务已被自动回滚（如触发器 RAISE(ROLLBACK) / INSERT OR ROLLBACK）；" +
        "自动回滚后的写入已拒绝以保证零残留。请保留原始错误并重启事务边界" +
        "（不得捕获后继续写入）",
      cause === undefined ? undefined : { cause },
    );
    this.name = "TransactionAutoRolledBackError";
  }
}

/**
 * 手工边界**状态不确定**（与"已确认自动回滚"的 TARB 区分）：记账中的手工
 * 边界已不存在（autocommit），但无法区分是所有者干净 COMMIT 还是发生了
 * 未被 wrapper 观察的自动回滚（Node 22/23 无检测手段）。fail-closed：该
 * 连接的 wrapper 写入一律拒绝（零残留——不确定态下重试可能把泄漏写入误当
 * 新事务提交），直到边界所有者调用 `endTransactionBoundary` 明确结束。
 * `cause` 保留探针错误（如 SQLITE_BUSY），便于审计。
 */
export class TransactionBoundaryUncertainError extends Error {
  constructor(cause?: unknown) {
    super(
      "kiwi-tx: 手工边界状态不确定（可能已干净结束，也可能发生了未被观察的自动回滚）；" +
        "wrapper 写入已拒绝以保证零残留。请由边界所有者调用 endTransactionBoundary " +
        "明确结束边界后再重试",
      cause === undefined ? undefined : { cause },
    );
    this.name = "TransactionBoundaryUncertainError";
  }
}

/**
 * 本 wrapper 是否已在当前连接上开启事务上下文。
 *
 * 只统计已登记的 wrapper 深度。尚未登记的手工 BEGIN 由 hasLiveTransaction 识别。
 */
export function isInsideTransaction(db: DatabaseSync): boolean {
  return (txDepth.get(db) ?? 0) > 0;
}

function isNestedTransactionError(err: unknown): boolean {
  return err instanceof Error && /within a transaction/i.test(err.message);
}

/**
 * 探针失败/成功后的分级处置（DeepSeek Node 22/23 复验 A/B 修复）：
 *
 * - **已确认死亡**（poison 已在、或 depth≥2、或 kind=wrapper——autocommit 本
 *   身即证据：记账中的事务已不存在，且除 wrapper 外无提交者）：fail-closed
 *   标记 poison，抛 TARB，`cause` 保留探针错误（含 busy——busy 只阻碍探针，
 *   不改变"事务已死"的判定）；恢复 = wrapper 自有边界 finally / 手工
 *   `endTransactionBoundary`。
 * - **depth=1 且手工边界**：autocommit 无法区分"所有者干净 COMMIT"与"未被
 *   观察的自动回滚"（busy 同样无法区分）——**不确定态 fail-closed**：标记
 *   uncertain，抛 TransactionBoundaryUncertainError（独立于 TARB，cause 保留
 *   busy/探针错误）；仅边界所有者 `endTransactionBoundary` 后恢复。
 */
function handleStaleBoundary(db: DatabaseSync, probeErr: unknown): never {
  const confirmedDead =
    txPoisoned.has(db) ||
    (txDepth.get(db) ?? 0) >= 2 ||
    txBoundaryKind.get(db) === "wrapper";
  if (confirmedDead) {
    txPoisoned.add(db);
    throw new TransactionAutoRolledBackError(probeErr);
  }
  txUncertain.add(db);
  throw new TransactionBoundaryUncertainError(probeErr);
}

/**
 * **手工边界所有者确认**：手工 BEGIN 边界内捕获到自动回滚错误（INSERT OR
 * ROLLBACK 冲突、RAISE(ROLLBACK) 触发器）后调用。此后该连接的 wrapper 写入
 * 一律拒绝（零残留），直到 `endTransactionBoundary` 明确结束边界。
 *
 * 为什么需要：**未被 wrapper 观察到的**自动回滚（含边界死亡时与 wrapper 无
 * 任何接触、以及顶层 fn 直接吞错的场景），wrapper 无从分辨"已死边界"与
 * "干净结束后的事务"——所有者的这一声明确认是唯一可靠信号。
 */
export function markTransactionAborted(db: DatabaseSync): void {
  txPoisoned.add(db);
}

/** Inspect manual transactions without promoting a WAL reader to a writer. */
function hasLiveTransaction(db: DatabaseSync): boolean {
  const active = db.isTransaction;
  if (typeof active === "boolean") return active;
  // Older node:sqlite has no flag. A plain BEGIN tests autocommit without a write lock.
  try {
    db.exec("begin deferred");
  } catch (error) {
    if (isNestedTransactionError(error)) return true;
    throw error;
  }
  db.exec("rollback"); // close only our newly opened, empty probe
  return false;
}

function assertBoundaryAlive(db: DatabaseSync): void {
  let cause: unknown;
  try {
    if (hasLiveTransaction(db)) return;
    // The tracked transaction is gone. Preserve the original lock-error evidence
    // for poisoned/uncertain boundaries without touching a live read transaction.
    db.exec("begin immediate");
    db.exec("rollback");
  } catch (error) {
    cause = error;
  }
  handleStaleBoundary(db, cause);
}

/** The caller verified the outer boundary before creating a SAVEPOINT. */
function runSavepoint<T>(db: DatabaseSync, fn: () => T): T {
  const depth = (txDepth.get(db) ?? 0) + 1;
  const name = `kiwi_tx_${depth}_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  txDepth.set(db, depth);
  try {
    const result = fn();
    try {
      db.exec(`RELEASE ${name}`);
    } catch (releaseErr) {
      // savepoint 已不存在 = 事务边界已被自动回滚销毁（fn 吞掉了原始错误）。
      // fail-closed：标记 poison 拒绝后续写，转为明确语义的 TARB 并以底层
      // 错误为 cause——原始错误由 fn 负责，wrapper 不伪造业务结果。
      txPoisoned.add(db);
      throw new TransactionAutoRolledBackError(releaseErr);
    }
    return result;
  } catch (error) {
    // RAISE(ROLLBACK) 触发器/INSERT OR ROLLBACK 等会让 SQLite 自动回滚整个
    // 事务，savepoint 随之消失：ROLLBACK TO/RELEASE 的次生错误吞掉，标记
    // poisoned（边界结束前拒绝一切新写入，防止 autocommit 部分提交），
    // 保留并重抛原始错误。
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      txPoisoned.add(db);
    }
    throw error;
  } finally {
    txDepth.set(db, depth - 1);
  }
}

/**
 * 手工 BEGIN/COMMIT 边界的所有者在**边界结束之后**调用（COMMIT/ROLLBACK
 * 已尝试，无论成败）：解除该连接上因自动回滚设置的 poison 与**状态不确定**
 * 标记（见 handleStaleBoundary / markTransactionAborted），恢复 wrapper 可用。
 *
 * 契约与限制：
 * - wrapper 自有边界（BEGIN 成功路径）由最外层 finally 自动解除——对本方法
 *   调用会被拒绝（不能半途解除 wrapper 上下文）；
 * - 嵌套 savepoint 上下文活跃（depth > 1）时调用被拒；
 * - **未观察到的自动回滚**（手工边界死亡时与 wrapper 无任何接触，且所有者
 *   未调用 `markTransactionAborted`）与"干净结束"不可区分——结束边界前该
 *   连接的 wrapper 写入按全新事务执行，不承诺零残留（见头注释）。
 */
export function endTransactionBoundary(db: DatabaseSync): void {
  if (txBoundaryKind.get(db) === "wrapper") {
    throw new Error("kiwi-tx: wrapper 自有边界由 wrapper 生命周期管理，不能手工结束");
  }
  if ((txDepth.get(db) ?? 0) > 1) {
    throw new Error("kiwi-tx: 嵌套 savepoint 上下文活跃，不能在此结束手工边界");
  }
  txPoisoned.delete(db);
  txUncertain.delete(db);
  txDepth.delete(db);
  txBoundaryKind.delete(db);
}

/**
 * 受控事务上下文（M1 收尾修复）：
 *
 * - **最外层**：`BEGIN IMMEDIATE` → fn → COMMIT / ROLLBACK——语义与既有
 *   完全一致，不扩大；
 * - **嵌套**：通过连接状态或无写锁的 BEGIN DEFERRED 探针识别手工边界，
 *   登记 kind=manual。使用显式 SAVEPOINT，内层失败只回滚到自己的进入点。
 * - **自动回滚恢复**：触发器 `RAISE(ROLLBACK)`、`INSERT OR ROLLBACK` 等会让
 *   SQLite 连事务一起回滚；嵌套入口的**事务活性探针**（见 assertBoundaryAlive）在
 *   depth 失真时分级拒绝并标记 poisoned，随后的 ROLLBACK/COMMIT/RELEASE
 *   次生错误一律吞掉，重抛原始错误——不掩盖、零残留。
 *
 * **实质边界**：以上保证只覆盖"经 wrapper 的写入"。两类未被 wrapper 观察到
 * 的自动回滚 wrapper 无法拦截、不声称零残留：(1) fn 吞掉自动回滚错误后直接
 * 执行的裸写（COMMIT 阶段确认失败会转 TARB 并保留 cause，但已 autocommit 的
 * 裸写不可撤销）；(2) 手工边界内未被观察的死亡且所有者未调用
 * `markTransactionAborted`（死亡与干净结束不可区分，结束后的 wrapper 调用
 * 按全新事务执行）——见 `markTransactionAborted` / `endTransactionBoundary`。
 * 事务内的业务写必须经 repository/wrapper。
 *
 * 这满足设计 §18.1"新增结果提交事务与现有 repository 共用连接，避免嵌套
 * 事务语义不清"：M4 `commitInternalResult` 的栅栏提交依赖本语义。模型调用
 * 与外网请求仍不得进入任何事务。
 */
export function inImmediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  // 自动回滚后的当前 wrapper 上下文内：拒绝一切新写入（零残留）。
  if (txPoisoned.has(db)) throw new TransactionAutoRolledBackError();
  // 手工边界状态不确定（可能干净结束、也可能未观察的自动回滚）：同样拒绝。
  if (txUncertain.has(db)) throw new TransactionBoundaryUncertainError();
  if (isInsideTransaction(db)) {
    assertBoundaryAlive(db);
    return runSavepoint(db, fn);
  }
  if (hasLiveTransaction(db)) {
    txDepth.set(db, 1);
    txBoundaryKind.set(db, "manual");
    return runSavepoint(db, fn);
  }
  db.exec("begin immediate");
  txDepth.set(db, 1);
  txBoundaryKind.set(db, "wrapper");
  try {
    const result = fn();
    try {
      db.exec("commit");
    } catch (commitErr) {
      if (
        commitErr instanceof Error &&
        /no transaction is active/i.test(commitErr.message)
      ) {
        // wrapper 自有事务在 COMMIT 时已不存在 = fn 期间被自动回滚且错误被
        // fn 吞掉——确认性失败：明确命名 + 保留原始 commit 错误为 cause，
        // 不伪造提交成功（fn 期间的裸写已 autocommit，属记录在案的实质边界）。
        throw new TransactionAutoRolledBackError(commitErr);
      }
      throw commitErr;
    }
    return result;
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // 事务已被自动回滚（RAISE(ROLLBACK) 等）。此路径的边界由本 wrapper 拥有，
      // finally 即解除；"自动回滚后继续写"的拦截由嵌套 savepoint 路径的
      // poison 负责（fn 内层检测到自动回滚时立即标记，先于外层 finally）。
    }
    throw error;
  } finally {
    txDepth.set(db, 0);
    txBoundaryKind.delete(db);
    txPoisoned.delete(db); // wrapper 自有边界结束即解除；手工边界见 endTransactionBoundary。
  }
}
