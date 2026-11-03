/**
 * 接待回复 outbox（P0a，设计 §15 ReplyOutbox / §16.1 会话顺序）：
 *
 * 每条已发布回复按会话分配严格递增的 reply_seq（由 conversation-store
 * 在发布事务内分配），本模块持久化出站记录：response_id、reply_seq、
 * 正文 digest、投递类别与状态。重试必须复用同一 response_id 与序号，
 * 不另占新序号。
 *
 * P0a 的 A2A 回复是同步进程内投递（记录即 dispatched）；异步渠道与
 * unknown 对账（§16.1 队首状态机）在 P0b 接入，状态枚举已预留。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ReplyOutboxStatus =
  /** 已交付（P0a：同步 A2A 响应即交付）。 */
  | "dispatched"
  /** 可证明未发送：因失效、撤权或明确处置被抑制，保留序号与原因。 */
  | "suppressed_unsent"
  /** 投递结果未知：阻塞本流对账，不得按 TTL 清空或换 ID 盲发（P0b）。 */
  | "unknown";

/** 投递类别由可信来源设置；模型不能自封 control_status 绕过暂停。 */
export type ReplyDispatchClass = "automatic" | "explicit_human" | "control_status";

export interface ReplyOutboxRecord {
  response_id: string;
  merchantId: string;
  identity: string;
  contextId: string;
  reply_seq: number;
  /** 正文内容 digest（JCS），不存原文（原文走会话留存，30 天）。 */
  text_digest: string;
  dispatch_class: ReplyDispatchClass;
  status: ReplyOutboxStatus;
  /** suppressed_unsent / unknown 时的真实原因。 */
  reason?: string;
  created_at: string;
}

export interface ReceptionReplyOutboxOptions {
  /** 绝对路径；父目录不存在时自动创建。 */
  file: string;
  now: () => string;
}

interface OutboxFile {
  version: 1;
  records: ReplyOutboxRecord[];
}

function keyOf(merchantId: string, identity: string, contextId: string): string {
  return JSON.stringify([merchantId, identity, contextId]);
}

export class ReceptionReplyOutbox {
  private readonly file: string;
  private readonly now: () => string;
  private state: OutboxFile;

  constructor(options: ReceptionReplyOutboxOptions) {
    this.file = options.file;
    this.now = options.now;
    this.state = this.load();
  }

  /** 登记一条已发布回复；response_id 重复（重试）时不重复登记。 */
  record(input: Omit<ReplyOutboxRecord, "created_at">): ReplyOutboxRecord {
    const existing = this.state.records.find(
      (item) => item.response_id === input.response_id,
    );
    if (existing !== undefined) return existing;
    const record: ReplyOutboxRecord = { ...input, created_at: this.now() };
    this.state.records.push(record);
    this.save();
    return record;
  }

  /** 更新投递状态（如对账后确认 unknown）；未知 response_id 返回 false。 */
  markStatus(responseId: string, status: ReplyOutboxStatus, reason?: string): boolean {
    const record = this.state.records.find((item) => item.response_id === responseId);
    if (record === undefined) return false;
    record.status = status;
    if (reason !== undefined) record.reason = reason;
    this.save();
    return true;
  }

  /** 按会话列出出站记录（reply_seq 升序）。 */
  list(merchantId: string, identity: string, contextId: string): ReplyOutboxRecord[] {
    const key = keyOf(merchantId, identity, contextId);
    return this.state.records
      .filter((item) => keyOf(item.merchantId, item.identity, item.contextId) === key)
      .sort((a, b) => a.reply_seq - b.reply_seq)
      .map((item) => ({ ...item }));
  }

  private load(): OutboxFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as OutboxFile;
      if (parsed.version === 1 && Array.isArray(parsed.records)) return parsed;
    } catch {
      // 首次启动或坏文件：从空 outbox 开始。
    }
    return { version: 1, records: [] };
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
