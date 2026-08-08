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

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { HandoffError } from "./errors.js";

export interface HandoffIdempotencyStoreOptions {
  dir: string;
  /** 保留期（缺省 7 天）。 */
  retentionDays?: number;
  now?: () => string;
  /**
   * 候选执行锁等待上限（ms，缺省 120_000）。executeHandoff 内可能含 URL
   * 探测（最长 15s 超时 × 重定向链），等待上限要容纳完整执行。
   */
  lockTimeoutMs?: number;
}

interface IdempotencyRow {
  candidate_id: string;
  candidate_digest: string;
  handoff_id: string;
  recorded_at: string;
}

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 25;
/** 陈旧锁阈值：持锁超此即视为崩溃残留（executeHandoff 锁持有上限 = 锁超时
 *  + URL 探测，10 分钟对正常操作是安全上限）。 */
const LOCK_STALE_MS = 10 * 60 * 1000;

export class HandoffIdempotencyStore {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly retentionMs: number;
  private readonly now: () => string;
  private readonly lockTimeoutMs: number;

  constructor(options: HandoffIdempotencyStoreOptions) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    chmodSync(options.dir, 0o700);
    this.dir = options.dir;
    this.filePath = path.join(options.dir, "handoff-idempotency.jsonl");
    this.retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * 以候选为粒度的互斥（§10.1 幂等的并发保护）：executeHandoff 的
   * lookup→(多次 await)→record 是 check-then-act，两个并发执行会双双通过
   * 幂等检查、同一候选交付两次。锁文件用 `openSync("wx")` 原子创建——
   * 单进程内 async 交错与跨进程共享 dir 两个场景都互斥；持锁期间崩溃由
   * 等待方超时（fail-closed：抛 HandoffError，绝不并发执行）。
   */
  async withCandidateLock<T>(
    candidateId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockDir = path.join(this.dir, "locks");
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const safeId = candidateId.replace(/[^A-Za-z0-9_-]/g, "_");
    const lockPath = path.join(lockDir, `${safeId}.lock`);
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx");
        closeSync(fd);
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
        // 陈旧锁自愈（评审项 B2）：持锁进程崩溃（finally 未执行）→ 锁文件
        // 永久残留，该候选永远 concurrency_lock_timeout（每次等满超时）。
        // mtime 超 LOCK_STALE_MS 即视为残留删除重试。
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // 锁文件刚被释放 → 重试
          continue;
        }
        if (Date.now() >= deadline) {
          throw new HandoffError(
            "concurrency_lock_timeout",
            `handoff candidate ${candidateId} is locked by another executor (waited ${this.lockTimeoutMs}ms); refusing concurrent execution`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // 锁文件已不存在（异常清理）则忽略。
      }
    }
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
    // 追加 + fsync（评审项 B2）：此前纯追加无 fsync，崩溃时最后一行可能
    // 撕裂——rows() 容忍撕裂行（跳过）→ 同候选再次执行会重复交付。fsync
    // 后成功返回即持久，重试路径可依赖幂等表。
    const fd = openSync(this.filePath, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(row)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
