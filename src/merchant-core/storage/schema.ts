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
 * 幂等加列（P2-1 刀 3 同构去重）。
 *
 * 此前逐字复制在三处（reconciliation-worker / webauthn-confirmation /
 * promotion-broadcast-workflow；webauthn 那份只有变量名不同）。SQLite 支持
 * ADD COLUMN 无需重建表；幂等判定读表结构——列已存在时重跑是 no-op。
 */

import type { DatabaseSync } from "node:sqlite";

export function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
