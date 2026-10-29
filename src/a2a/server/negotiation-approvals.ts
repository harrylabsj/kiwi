/**
 * 商家议价审批队列（B2）：把「低于自动折扣边界」的还价从硬拒改为
 * **待人工审批 → 一次性授权 → 买家重试命中**。
 *
 * 协议约束：A2A 没有商家主动推送通道，买家侧 counter 也受幂等轮次限制，
 * 因此不在请求内长时间挂起（买家 timeout 只有秒级）。审批完成后由买家
 * 发起下一轮 counter，商家用本队列里的一次性授权价应答；授权只能消费
 * 一次，过期即失效。
 *
 * 存储刻意保持本地小文件（`<dataDir>/a2a/negotiation-approvals.json`）：
 * 与商家其余运行时状态同目录；只保存议价事实，不保存聊天历史或买家身份。
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type NegotiationApprovalStatus = "pending" | "approved" | "consumed" | "expired";

export interface NegotiationApprovalRecord {
  approval_id: string;
  negotiation_id: string;
  sku: string;
  currency: string;
  quantity: number;
  unit?: string;
  /** 买家本轮还价（单价 minor）。 */
  buyer_offer_minor: number;
  /** 商家公开自动折扣边界（可安全公开的报价下限）。 */
  public_bound_minor?: number;
  /** 私有底价（只在商家本地文件里出现，绝不进入 wire）。 */
  floor_minor?: number;
  /** 买家本轮消息 id，便于商家核对上下文。 */
  buyer_message_id?: string;
  status: NegotiationApprovalStatus;
  created_at: string;
  updated_at: string;
  /** 人工批准的单价（minor）；仅 approved/consumed 有值。 */
  approved_minor?: number;
  approved_by?: string;
  expires_at?: string;
}

export interface PendingApprovalInput {
  negotiation_id: string;
  sku: string;
  currency: string;
  quantity: number;
  unit?: string;
  buyer_offer_minor: number;
  public_bound_minor?: number;
  floor_minor?: number;
  buyer_message_id?: string;
}

export interface ApproveInput {
  /** approval_id 或 negotiation_id（二选一）。 */
  approval_id?: string;
  negotiation_id?: string;
  sku?: string;
  approved_minor: number;
  /** 授权有效期，秒；缺省 1 小时。 */
  ttl_seconds?: number;
  approved_by?: string;
}

export interface ConsumeInput {
  negotiation_id: string;
  sku: string;
  /** 可选匹配条件：单位/数量/币种不一致时不消费该授权。 */
  currency?: string;
  quantity?: number;
  unit?: string;
}

const DEFAULT_TTL_SECONDS = 3_600;
/** 终态记录保留期：pending/approved 永不按时间修剪。 */
const TERMINAL_RETENTION_MS = 30 * 86_400_000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;

interface FileShape {
  version: 1;
  records: NegotiationApprovalRecord[];
}

/** 本地审批队列；文件写入为 tmp+rename，读时容忍文件缺失。 */
export class NegotiationApprovalStore {
  private readonly file: string;
  private readonly now: () => string;

  /**
   * 按 Runtime 数据目录打开：状态文件固定落在 `<dataDir>/a2a/`。
   *
   * A2A 节点与 `kiwi merchant approvals` 必须用同一个约定，否则运营看到
   * 的是空队列（曾因节点多拼一层 `a2a` 出现）。
   */
  static forDataDir(dataDir: string, now?: () => string): NegotiationApprovalStore {
    return new NegotiationApprovalStore(path.join(dataDir, "a2a"), now);
  }

  constructor(dir: string, now: () => string = () => new Date().toISOString()) {
    this.file = path.join(dir, "negotiation-approvals.json");
    this.now = now;
  }

  private read(): FileShape {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<FileShape>;
      if (Array.isArray(raw.records)) return { version: 1, records: raw.records };
    } catch {
      // 文件缺失或损坏：从空队列开始，不猜测历史状态。
    }
    return { version: 1, records: [] };
  }

  private write(records: NegotiationApprovalRecord[]): void {
    // 记录里有私有底价，目录与文件都只允许本用户读写。
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, records } satisfies FileShape, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmp, this.file);
  }

  /**
   * 跨进程读-改-写锁：A2A 节点与 `kiwi merchant approvals` CLI 共享同一
   * 文件。`open(..., "wx")` 原子创建；持有者崩溃留下的旧锁按 mtime 回收。
   */
  private withLock<T>(work: () => T): T {
    const lock = `${this.file}.lock`;
    mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lock, "wx", 0o600);
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error("negotiation approval store is locked by another process", { cause: err });
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return work();
    } finally {
      try {
        closeSync(fd);
      } finally {
        try {
          unlinkSync(lock);
        } catch {
          // 锁已被其他清理者移除；主操作已完成。
        }
      }
    }
  }

  private pruneTerminal(records: NegotiationApprovalRecord[]): NegotiationApprovalRecord[] {
    const nowMs = Date.parse(this.now());
    const cutoff = nowMs - TERMINAL_RETENTION_MS;
    return records.filter(
      (record) =>
        record.status === "pending" ||
        (record.status === "approved" && !this.expired(record, nowMs)) ||
        Date.parse(record.updated_at) >= cutoff,
    );
  }

  private expired(record: NegotiationApprovalRecord, nowMs: number): boolean {
    return (
      record.expires_at !== undefined &&
      Number.isFinite(Date.parse(record.expires_at)) &&
      Date.parse(record.expires_at) <= nowMs
    );
  }

  /** 记录一笔超额还价（同 negotiation+sku 的 pending 只保留最新一条）。 */
  recordPending(input: PendingApprovalInput): NegotiationApprovalRecord {
    return this.withLock(() => this.recordPendingLocked(input));
  }

  private recordPendingLocked(input: PendingApprovalInput): NegotiationApprovalRecord {
    const now = this.now();
    const shape = this.read();
    const records = shape.records.filter(
      (record) =>
        !(
          record.negotiation_id === input.negotiation_id &&
          record.sku === input.sku &&
          record.status === "pending"
        ),
    );
    const record: NegotiationApprovalRecord = {
      approval_id: `nap_${randomUUID()}`,
      negotiation_id: input.negotiation_id,
      sku: input.sku,
      currency: input.currency,
      quantity: input.quantity,
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      buyer_offer_minor: input.buyer_offer_minor,
      ...(input.public_bound_minor !== undefined ? { public_bound_minor: input.public_bound_minor } : {}),
      ...(input.floor_minor !== undefined ? { floor_minor: input.floor_minor } : {}),
      ...(input.buyer_message_id !== undefined ? { buyer_message_id: input.buyer_message_id } : {}),
      status: "pending",
      created_at: now,
      updated_at: now,
    };
    records.push(record);
    this.write(this.pruneTerminal(records));
    return record;
  }

  list(status?: NegotiationApprovalStatus): NegotiationApprovalRecord[] {
    const nowMs = Date.parse(this.now());
    return this.read().records.map((record) =>
      record.status === "pending" || record.status === "approved"
        ? this.expired(record, nowMs)
          ? { ...record, status: "expired" as const }
          : record
        : record,
    ).filter((record) => status === undefined || record.status === status);
  }

  /** 人工批准：写入批准价与有效期；找不到 pending 记录即失败（不凭空造授权）。 */
  approve(input: ApproveInput): NegotiationApprovalRecord {
    return this.withLock(() => this.approveLocked(input));
  }

  private approveLocked(input: ApproveInput): NegotiationApprovalRecord {
    if (input.approved_minor < 0 || !Number.isSafeInteger(input.approved_minor)) {
      throw new Error("approved_minor must be a non-negative integer");
    }
    const shape = this.read();
    const record = shape.records.find(
      (candidate) =>
        candidate.status === "pending" &&
        (input.approval_id !== undefined
          ? candidate.approval_id === input.approval_id
          : candidate.negotiation_id === input.negotiation_id &&
            (input.sku === undefined || candidate.sku === input.sku)),
    );
    if (record === undefined) {
      throw new Error("no pending negotiation approval matches the request");
    }
    const now = this.now();
    const ttl = input.ttl_seconds ?? DEFAULT_TTL_SECONDS;
    record.status = "approved";
    record.approved_minor = input.approved_minor;
    record.approved_by = input.approved_by ?? "merchant";
    record.expires_at = new Date(Date.parse(now) + ttl * 1_000).toISOString();
    record.updated_at = now;
    this.write(this.pruneTerminal(shape.records));
    return record;
  }

  /**
   * 买家重试还价时消费一次性授权：只有 approved 且未过期才命中，命中即
   * 标记 consumed（同一授权不能回答两笔还价）。返回 undefined 表示没有
   * 可用授权，调用方继续走常规边界逻辑。
   */
  consume(input: ConsumeInput): NegotiationApprovalRecord | undefined {
    return this.withLock(() => this.consumeLocked(input));
  }

  private consumeLocked(input: ConsumeInput): NegotiationApprovalRecord | undefined {
    const nowMs = Date.parse(this.now());
    const shape = this.read();
    const record = shape.records.find(
      (candidate) =>
        candidate.negotiation_id === input.negotiation_id &&
        candidate.sku === input.sku &&
        candidate.status === "approved" &&
        !this.expired(candidate, nowMs) &&
        (input.currency === undefined || candidate.currency === input.currency) &&
        (input.quantity === undefined || candidate.quantity === input.quantity) &&
        (input.unit === undefined || candidate.unit === input.unit),
    );
    if (record === undefined) return undefined;
    record.status = "consumed";
    record.updated_at = this.now();
    this.write(this.pruneTerminal(shape.records));
    return record;
  }
}
