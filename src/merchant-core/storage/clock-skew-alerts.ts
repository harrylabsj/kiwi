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
 * 时钟偏移告警落库（P2-1 刀 3 同构去重）。
 *
 * 此前近似复制在两处（reconciliation-worker :200-252 / external-delivery
 * :220-264）：同一份「clock_skew 告警 upsert + 复活时作废旧投递」逻辑两份
 * 实现，clock-safety 的告警语义改一处忘一处就会两库分叉。
 *
 * 两处的唯一实质差异在复活分支删除投递记录前：reconciliation-worker 先查
 * `workbench_alert_deliveries` 表是否存在（它的管理库不一定初始化过投递表——
 * 该表由 external-delivery 的 SCHEMA 建），external-delivery 直接 DELETE（自己
 * 构造时必建）。统一为「查表存在再删」：对 external-delivery 表恒存在，行为
 * 逐字等价；对 reconciliation-worker 保持原守卫。其余差异（alertId 提前提取
 * vs 分支内联）本就行为等价。
 */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function recordClockSkewAlert(
  db: DatabaseSync,
  stamp: string,
  input: { merchantId: string; paused: boolean; offsetMs: number },
): void {
  if (!input.paused) {
    db.prepare(
      `UPDATE workbench_alerts SET resolved_at=?
       WHERE merchant_id=? AND category='clock_skew' AND resource='clock:system'
         AND episode='clock-skew' AND resolved_at IS NULL`,
    ).run(stamp, input.merchantId);
    return;
  }
  const existing = db
    .prepare(
      `SELECT alert_id, resolved_at FROM workbench_alerts
       WHERE merchant_id=? AND category='clock_skew' AND resource='clock:system'
         AND episode='clock-skew'`,
    )
    .get(input.merchantId) as { alert_id: string; resolved_at: string | null } | undefined;
  const alertId = existing?.alert_id ?? `wba_${randomBytes(12).toString("hex")}`;
  const summary = `System clock skew exceeded limit: offset_ms=${Math.round(input.offsetMs)}`;
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO workbench_alerts
       (alert_id, merchant_id, category, resource, episode, severity, summary, created_at)
       VALUES (?, ?, 'clock_skew', 'clock:system', 'clock-skew', 'critical', ?, ?)`,
    ).run(alertId, input.merchantId, summary, stamp);
    return;
  }
  if (existing.resolved_at === null) {
    db.prepare("UPDATE workbench_alerts SET severity='critical', summary=? WHERE alert_id=?").run(
      summary,
      alertId,
    );
    return;
  }
  // 已解决的告警重新超标 = 新告警事件：复活该行（清空解决/确认痕迹）。
  db.prepare(
    `UPDATE workbench_alerts SET severity='critical', summary=?, created_at=?, resolved_at=NULL,
       acknowledged_at=NULL, acknowledged_by=NULL WHERE alert_id=?`,
  ).run(summary, stamp, alertId);
  // 复活后既有投递记录作废，让投递器重新排队。查表存在性：本函数被两个库
  // 共用，管理库不一定初始化过投递表（见模块头）。
  const deliveriesPresent = db
    .prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='workbench_alert_deliveries'")
    .get() as { present: number } | undefined;
  if (deliveriesPresent?.present === 1) {
    db.prepare("DELETE FROM workbench_alert_deliveries WHERE alert_id=?").run(alertId);
  }
}
