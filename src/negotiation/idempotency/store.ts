/**
 * 协议级幂等存储（基线 §17 / 子规范 §20）。
 *
 * 独立于 Ledger 持久化（幂等索引与审计链可分开部署），但每次 commit 记录都会
 * 引用判定证据所在 Ledger 事件（ledger_event_id / ledger_event_digest，§22）。
 *
 * 判定流程（check → 执行/重放/冲突）：
 *   1. check((sender_identity, message_id, digest))
 *      - 无记录或已过期         → { status: "new" }        调用方执行业务效果
 *      - 同 key 同 digest       → { status: "replayed" }   返回原结果，绝不重复执行
 *      - 同 key 异 digest       → { status: "conflict" }   返回 idempotency_conflict，fail-closed
 *   2. 执行成功后 commit(输入 + outcome + ledger 证据) → 落盘。
 *      commit 再次核验：key 已存在且 digest 不同 → 抛 IdempotencyConflictError
 *      （check 与 commit 之间的并发兜底）。
 *
 * retention（§20.5）：expires_at = max(now + 24h, offer_valid_until,
 * task_lifetime_until)；sweep() 删除 expires_at <= now 的记录（可独立于 Ledger
 * 执行 —— Ledger 是 append-only 审计链，删除幂等索引不影响审计完整性）。
 *
 * 本地持久化：目录 0700、文件 0600；写采用 supervisor/manifest.ts 的原子写
 * （同目录临时文件 wx + fsync + rename）。
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { sha256Hex } from "../jcs.js";
import { IdempotencyConflictError, computeRetentionDeadline, idempotencyKey } from "./types.js";
import type {
  IdempotencyCheckInput,
  IdempotencyCommitInput,
  IdempotencyDecision,
  IdempotencyRecord,
} from "./types.js";

export interface IdempotencyStoreOptions {
  /** 基础数据目录；幂等记录落在 `<dir>/idempotency/`。 */
  dir: string;
  /** 可注入时钟（RFC 3339）；缺省用 new Date().toISOString()。 */
  now?: () => string;
}

let tmpSeq = 0;

export class IdempotencyStore {
  private readonly baseDir: string;
  private readonly indexDir: string;
  private readonly now: () => string;

  constructor(options: IdempotencyStoreOptions) {
    this.baseDir = options.dir;
    this.indexDir = path.join(options.dir, "idempotency");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private ensureIndexDir(): string {
    mkdirSync(this.indexDir, { recursive: true, mode: 0o700 });
    chmodSync(this.indexDir, 0o700);
    return this.indexDir;
  }

  /** 记录文件名：`idem-<sha256(key)>.json`。key 内容在文件内自描述。 */
  private filePathFor(key: string): string {
    const dir = this.ensureIndexDir();
    const name = `idem-${sha256Hex(key)}.json`;
    return path.resolve(dir, name);
  }

  private writeFileAtomic(filePath: string, record: IdempotencyRecord): void {
    const tmp = `${filePath}.tmp-${process.pid}-${++tmpSeq}`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
  }

  private readRecord(key: string): IdempotencyRecord | null {
    const filePath = this.filePathFor(key);
    if (!existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Partial<IdempotencyRecord>;
    if (
      typeof record.sender_identity !== "string" ||
      typeof record.message_id !== "string" ||
      typeof record.digest !== "string" ||
      typeof record.negotiation_id !== "string" ||
      typeof record.recorded_at !== "string" ||
      typeof record.expires_at !== "string" ||
      record.outcome === undefined ||
      typeof record.outcome !== "object"
    ) {
      return null;
    }
    return record as IdempotencyRecord;
  }

  /** 记录是否已过期（expires_at <= nowIso）。 */
  private isExpired(record: IdempotencyRecord, nowIso: string): boolean {
    return Date.parse(record.expires_at) <= Date.parse(nowIso);
  }

  /**
   * 幂等三态判定（§20.1–§20.3）。只读，不写盘。
   * 已过期记录视同「新消息」：retention 窗口外重放由状态校验决定，而非幂等层。
   */
  check(input: IdempotencyCheckInput): IdempotencyDecision {
    const key = idempotencyKey(input.sender_identity, input.message_id);
    const existing = this.readRecord(key);
    if (existing === null || this.isExpired(existing, this.now())) {
      return { status: "new", key };
    }
    if (existing.digest === input.digest) {
      return { status: "replayed", key, record: existing };
    }
    return { status: "conflict", key, record: existing };
  }

  /**
   * 提交一次成功处理。check 之后调用；若 check 与 commit 之间已有同 key 记录，
   * 同 digest → 幂等返回既有记录；异 digest → 抛 IdempotencyConflictError。
   */
  commit(input: IdempotencyCommitInput): IdempotencyRecord {
    const key = idempotencyKey(input.sender_identity, input.message_id);
    const existing = this.readRecord(key);
    if (existing !== null && !this.isExpired(existing, this.now())) {
      if (existing.digest === input.digest) return existing;
      throw new IdempotencyConflictError(existing, input.digest);
    }
    const nowIso = this.now();
    const expiresAt = computeRetentionDeadline(new Date(nowIso), input.retention).toISOString();
    const record: IdempotencyRecord = {
      sender_identity: input.sender_identity,
      message_id: input.message_id,
      digest: input.digest,
      negotiation_id: input.negotiation_id,
      outcome: input.outcome,
      recorded_at: nowIso,
      expires_at: expiresAt,
    };
    if (input.ledger_event_id !== undefined) record.ledger_event_id = input.ledger_event_id;
    if (input.ledger_event_digest !== undefined) {
      record.ledger_event_digest = input.ledger_event_digest;
    }
    this.writeFileAtomic(this.filePathFor(key), record);
    return record;
  }

  /** 读取记录（供恢复/调试）；未知或已过期返回 null。 */
  get(senderIdentity: string, messageId: string): IdempotencyRecord | null {
    const key = idempotencyKey(senderIdentity, messageId);
    const record = this.readRecord(key);
    if (record === null) return null;
    return this.isExpired(record, this.now()) ? null : record;
  }

  /** 过期记录清理；返回移除条数。不触碰 Ledger（§22：删除索引不影响审计链）。 */
  sweep(nowIso?: string): number {
    const dir = this.ensureIndexDir();
    const now = nowIso ?? this.now();
    let removed = 0;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("idem-") || !name.endsWith(".json")) continue;
      const filePath = path.join(dir, name);
      try {
        const record = this.readRecordFromPath(filePath);
        if (record !== null && this.isExpired(record, now)) {
          rmSync(filePath);
          removed += 1;
        }
      } catch {
        // 单个损坏记录不阻断 sweep；继续清理其余。
      }
    }
    return removed;
  }

  /** 索引规模（含过期，供诊断）。 */
  count(): number {
    const dir = this.ensureIndexDir();
    return readdirSync(dir).filter((name) => name.startsWith("idem-") && name.endsWith(".json"))
      .length;
  }

  private readRecordFromPath(filePath: string): IdempotencyRecord | null {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as IdempotencyRecord;
  }
}
