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
 * HandoffIdempotencyStore —— 执行域幂等（KTH rev0.3 §10.1）。
 *
 * 幂等键：(source_candidate_id, source_candidate_digest)。与 negotiation
 * 的 `(sender_identity, message_id)` 协议域幂等**不混用**——handoff 重试
 * 窗口比 24h 长（候选可能存活数天），保留期缺省 ≥ 7 天。
 *
 * 存储：JSONL（`<dir>/handoff-idempotency.jsonl`，目录 0700），追加式 +
 * 惰性清理过期行。lookup 命中 → 返回已交付的 handoff_id（重试不重复交付）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface HandoffIdempotencyStoreOptions {
  dir: string;
  /** 保留期（缺省 7 天）。 */
  retentionDays?: number;
  now?: () => string;
}

interface IdempotencyRow {
  candidate_id: string;
  candidate_digest: string;
  handoff_id: string;
  recorded_at: string;
}

const DEFAULT_RETENTION_DAYS = 7;

export class HandoffIdempotencyStore {
  private readonly filePath: string;
  private readonly retentionMs: number;
  private readonly now: () => string;

  constructor(options: HandoffIdempotencyStoreOptions) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    chmodSync(options.dir, 0o700);
    this.filePath = path.join(options.dir, "handoff-idempotency.jsonl");
    this.retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 幂等查询：同候选同 digest 已交付 → 返回 handoff_id。 */
  lookup(candidateId: string, candidateDigest: string): { handoff_id: string } | undefined {
    for (const row of this.rows()) {
      if (row.candidate_id === candidateId && row.candidate_digest === candidateDigest) {
        return { handoff_id: row.handoff_id };
      }
    }
    return undefined;
  }

  /** 记录一次成功交付（幂等键 → handoff_id）。 */
  record(candidateId: string, candidateDigest: string, handoffId: string): void {
    const row: IdempotencyRow = {
      candidate_id: candidateId,
      candidate_digest: candidateDigest,
      handoff_id: handoffId,
      recorded_at: this.now(),
    };
    writeFileSync(this.filePath, `${JSON.stringify(row)}\n`, { flag: "a", mode: 0o600 });
  }

  /** 惰性清理：删除超过保留期的行（重写文件，原子 rename）。 */
  prune(): number {
    const cutoff = Date.parse(this.now()) - this.retentionMs;
    const rows = this.rows();
    const fresh = rows.filter((row) => Date.parse(row.recorded_at) >= cutoff);
    if (fresh.length === rows.length) return 0;
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, fresh.map((r) => JSON.stringify(r)).join("\n") + (fresh.length > 0 ? "\n" : ""), {
      mode: 0o600,
    });
    renameSync(tmp, this.filePath);
    return rows.length - fresh.length;
  }

  private rows(): IdempotencyRow[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8");
    const rows: IdempotencyRow[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as IdempotencyRow;
        if (typeof parsed.candidate_id === "string" && typeof parsed.handoff_id === "string") {
          rows.push(parsed);
        }
      } catch {
        // 撕裂行跳过（审计由 Ledger 承担；幂等表容忍最后一行撕裂）。
      }
    }
    return rows;
  }
}
