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
 * 服务可取用性状态（BD 设计 §9.1 的 service_state 与 §10.1 的 pause/resume 命令）。
 *
 * 边界（沿用 M4 T012 的实测教训：就绪 ≠ 业务可取用性）：这里只保存**操作者
 * 显式声明**的状态（管理 API 命令或 KIWI_CLOUD_SERVICE_STATE 初始值），绝不
 * 从就绪检查推导「停业」；resume 的就绪门由调用方先取就绪结论再传入
 * （BD §10.1：恢复要重新通过就绪门，不是只翻转布尔值）。
 *
 * 撤回（WITHDRAWN）是独立生命周期（BD §16.3）：不能经 pause/resume 进入或复活。
 */

import { ManagementError, type ServiceState } from "../../merchant/application/service.js";
import type { DatabaseSync } from "node:sqlite";

/** A2A 闸门形状（与 createA2aNodeCore 的 serviceAvailability.check 同形）。 */
export type ServiceGateCheck =
  { accepting: true } | { accepting: false; state: string; reason: string };

const SERVICE_STATE_VALUES: ReadonlySet<string> = new Set([
  "OPERATING",
  "PAUSED",
  "WITHDRAWN",
  "DEGRADED",
]);

export class MutableServiceState {
  private stateValue: ServiceState;
  private revisionValue: number;
  private stateReason: string;
  private persistence?: { db: DatabaseSync; merchantId: string };

  constructor(initial: ServiceState = "OPERATING") {
    this.stateValue = initial;
    this.revisionValue = 1;
    this.stateReason = initial === "OPERATING" ? "" : "declared by the operator";
  }

  /**
   * 环境声明 → 初始状态（与 M4 行为一致：任何非 OPERATING 的显式声明都关闸）。
   * 无法识别的声明按 DEGRADED 关闸——绝不静默营业。
   */
  static fromDeclared(raw: string | undefined): MutableServiceState {
    const declared = String(raw ?? "")
      .trim()
      .toUpperCase();
    if (declared === "" || declared === "OPERATING") return new MutableServiceState("OPERATING");
    if (SERVICE_STATE_VALUES.has(declared)) {
      return new MutableServiceState(declared as ServiceState);
    }
    return new MutableServiceState("DEGRADED");
  }

  attachPersistence(db: DatabaseSync, merchantId: string): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_service_control (
        merchant_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('OPERATING','PAUSED','WITHDRAWN','DEGRADED')),
        revision INTEGER NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const row = db
      .prepare("SELECT state, revision, reason FROM workbench_service_control WHERE merchant_id=?")
      .get(merchantId) as { state: ServiceState; revision: number; reason: string } | undefined;
    this.persistence = { db, merchantId };
    if (row === undefined) {
      this.insertCurrent();
      return;
    }
    // A persisted safety state wins over an implicit OPERATING startup. An explicit
    // non-operating declaration may only tighten a previously operating row.
    if (row.state === "OPERATING" && this.stateValue !== "OPERATING") {
      this.revisionValue = row.revision + 1;
      this.persistCurrent(row.revision);
      return;
    }
    this.stateValue = row.state;
    this.revisionValue = row.revision;
    this.stateReason = row.reason;
  }

  get state(): ServiceState {
    return this.stateValue;
  }

  /** 服务状态版本（pause/resume 写命令的乐观并发依据；每次状态迁移递增）。 */
  get serviceRevision(): number {
    return this.revisionValue;
  }

  get reason(): string {
    return this.stateReason;
  }

  gateCheck(): ServiceGateCheck {
    if (this.stateValue === "OPERATING") return { accepting: true };
    return { accepting: false, state: this.stateValue, reason: this.stateReason };
  }

  /** 暂停：拒新询价，既有任务不受影响（T012 语义）。已 PAUSED 时幂等原样返回。 */
  pause(reason: string | undefined): { service_revision: number } {
    if (this.stateValue === "WITHDRAWN") {
      throw new ManagementError("conflict", "service is withdrawn; pause is not applicable");
    }
    if (this.stateValue === "PAUSED") return { service_revision: this.revisionValue };
    const text = String(reason ?? "").trim();
    const previousState = this.stateValue;
    const previousReason = this.stateReason;
    this.stateValue = "PAUSED";
    this.stateReason = text === "" ? "paused by the operator" : `paused by the operator: ${text}`;
    try {
      this.advancePersistedRevision();
    } catch (error) {
      this.stateValue = previousState;
      this.stateReason = previousReason;
      throw error;
    }
    return { service_revision: this.revisionValue };
  }

  /**
   * 恢复：`readinessOk=false` → 503 且状态不变（就绪门，BD §10.1）。
   * 撤回态不可经 resume 复活。
   */
  resume(readinessOk: boolean, failedChecks: readonly string[]): { service_revision: number } {
    if (this.stateValue === "WITHDRAWN") {
      throw new ManagementError("conflict", "service is withdrawn; resume is not applicable");
    }
    if (!readinessOk) {
      const detail = failedChecks.length > 0 ? ` (${failedChecks.join(",")})` : "";
      throw new ManagementError(
        "unavailable",
        `readiness gate failed; refusing to resume${detail}`,
      );
    }
    if (this.stateValue === "OPERATING") return { service_revision: this.revisionValue };
    const previousState = this.stateValue;
    const previousReason = this.stateReason;
    this.stateValue = "OPERATING";
    this.stateReason = "";
    try {
      this.advancePersistedRevision();
    } catch (error) {
      this.stateValue = previousState;
      this.stateReason = previousReason;
      throw error;
    }
    return { service_revision: this.revisionValue };
  }

  private insertCurrent(): void {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    persistence.db
      .prepare(
        `INSERT INTO workbench_service_control
         (merchant_id, state, revision, reason, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        persistence.merchantId,
        this.stateValue,
        this.revisionValue,
        this.stateReason,
        new Date().toISOString(),
      );
  }

  private advancePersistedRevision(): void {
    const previous = this.revisionValue;
    this.revisionValue += 1;
    try {
      this.persistCurrent(previous);
    } catch (error) {
      this.revisionValue = previous;
      throw error;
    }
  }

  private persistCurrent(expectedRevision: number): void {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    const changed = persistence.db
      .prepare(
        `UPDATE workbench_service_control
         SET state=?, revision=?, reason=?, updated_at=?
         WHERE merchant_id=? AND revision=?`,
      )
      .run(
        this.stateValue,
        this.revisionValue,
        this.stateReason,
        new Date().toISOString(),
        persistence.merchantId,
        expectedRevision,
      );
    if (changed.changes !== 1) {
      throw new ManagementError("conflict", "service control revision changed concurrently");
    }
  }
}
