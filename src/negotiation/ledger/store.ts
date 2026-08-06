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
 * KNP/1.0 Negotiation Ledger 存储（基线 §22 / §23 / 子规范 §28）。
 *
 * - append-only：链上每条事件的 previous_event_digest 由 store 按当前链尾计算，
 *   调用方无法伪造链指针；不存在 update/delete 接口。链结构（event_digest →
 *   previous_event_digest）保证任何中间删除/改写在 verifyChain 中被检出。
 * - content-addressed：event_digest 是对事件稳定内容（event.ts 的
 *   eventContentAddressable）的 SHA-256 摘要。同一逻辑内容只能落账一次，
 *   重复内容 append 时抛 ledger_duplicate_content（§22 内容寻址去重）。
 * - hash-linked：verifyChain 逐条重算 digest 并核对链接；断链（chain_break）
 *   与篡改（tampered）是两种可区分的错误，另有 corrupt（坏行）与 duplicate。
 * - 本地持久化（对齐 WP0 L2 基线）：目录 0700、文件 0600。append 采用与
 *   supervisor/manifest.ts 相同的原子写：同目录临时文件（wx + fsync）+ rename。
 *   全量重写换取 append 的原子性：要么旧链完整，要么新链完整，永不撕裂。
 *
 * 查询能力（§23 Recovery）：
 *   events()                  按 negotiation_id 取事件序列
 *   highWaterMark()           高水位（count / last_event_digest / last_message_id）
 *   findByMessageId()         按 message_id 查重（比较 acknowledged messages）
 *   verifyChain()             链完整性
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { sha256Hex } from "../jcs.js";
import { LedgerError, computeEventDigest, eventContentAddressable } from "./event.js";
import { assertNoForbiddenContent, isLedgerEvent, newLedgerEventId } from "./event.js";
import type { LedgerEvent, LedgerEventContent, LedgerVerifyResult } from "./event.js";

export interface LedgerHighWaterMark {
  negotiation_id: string;
  count: number;
  last_event_id: string | null;
  last_event_digest: string | null;
  last_recorded_at: string | null;
  last_message_id?: string;
}

export interface LedgerStoreOptions {
  /** 基础数据目录；Ledger 文件落在 `<dir>/ledger/`。 */
  dir: string;
  /** 可注入时钟（RFC 3339）；缺省用 new Date().toISOString()。 */
  now?: () => string;
}

let tmpSeq = 0;

/**
 * 将 opaque negotiation_id 映射为安全文件名：合法字符保留，其余归一为 `_`，
 * 再附加 id 的 sha256 前缀防止不同 id 归一化碰撞。id 含 `/` 也无法逃逸目录。
 */
export function ledgerFileName(negotiationId: string): string {
  const sanitized = negotiationId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${sanitized}.${sha256Hex(negotiationId).slice(0, 12)}.jsonl`;
}

export class LedgerStore {
  private readonly baseDir: string;
  private readonly ledgerDir: string;
  private readonly now: () => string;

  constructor(options: LedgerStoreOptions) {
    this.baseDir = options.dir;
    this.ledgerDir = path.join(options.dir, "ledger");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** ledger 目录（0700），不存在则创建。 */
  private ensureLedgerDir(): string {
    mkdirSync(this.ledgerDir, { recursive: true, mode: 0o700 });
    chmodSync(this.ledgerDir, 0o700);
    return this.ledgerDir;
  }

  /** negotiation_id → 绝对文件路径（含路径包含检查）。 */
  private filePathFor(negotiationId: string): string {
    const dir = this.ensureLedgerDir();
    const resolved = path.resolve(dir, ledgerFileName(negotiationId));
    if (!resolved.startsWith(`${dir}${path.sep}`)) {
      throw new LedgerError("ledger_invalid_identity", `negotiation_id escapes ledger dir`);
    }
    return resolved;
  }

  /** 原子写（对齐 supervisor/manifest.ts：同目录临时文件 + fsync + rename，0600）。 */
  private writeFileAtomic(filePath: string, content: string): void {
    const tmp = `${filePath}.tmp-${process.pid}-${++tmpSeq}`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
  }

  /** 解析一个 JSONL 行；非对象/非事件形状抛 ledger_chain_corrupt。 */
  private parseLine(line: string, index: number): LedgerEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new LedgerError(
        "ledger_chain_corrupt",
        `ledger line ${index} is not valid JSON`,
        index,
      );
    }
    if (!isLedgerEvent(parsed)) {
      throw new LedgerError(
        "ledger_chain_corrupt",
        `ledger line ${index} does not have the required event shape`,
        index,
      );
    }
    return parsed;
  }

  /** 从磁盘读取某 negotiation 的完整事件序列；文件缺失返回 []。 */
  private load(negotiationId: string): LedgerEvent[] {
    const filePath = this.filePathFor(negotiationId);
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    return lines.map((line, i) => this.parseLine(line, i));
  }

  /** 某 negotiation 是否已有记录。 */
  hasNegotiation(negotiationId: string): boolean {
    return this.load(negotiationId).length > 0;
  }

  /** 取某 negotiation 的完整事件序列（磁盘直读，不缓存）。 */
  events(negotiationId: string): LedgerEvent[] {
    return this.load(negotiationId);
  }

  /** 高水位（§23 恢复第 2 步）：count / 链尾 digest / 末条 message_id。 */
  highWaterMark(negotiationId: string): LedgerHighWaterMark {
    const events = this.load(negotiationId);
    const tail = events.at(-1);
    const mark: LedgerHighWaterMark = {
      negotiation_id: negotiationId,
      count: events.length,
      last_event_id: tail?.event_id ?? null,
      last_event_digest: tail?.event_digest ?? null,
      last_recorded_at: tail?.recorded_at ?? null,
    };
    if (tail?.message_id !== undefined) mark.last_message_id = tail.message_id;
    return mark;
  }

  /**
   * Append 一条事件。链接由当前链尾计算；重复内容（同 event_digest）拒绝。
   * 返回完整事件（含 event_id / digests / recorded_at）。
   */
  append(content: LedgerEventContent): LedgerEvent {
    // 禁词前置检查：绝不把 CoT / Vault plaintext 落盘（§22 / §28 / §36-5）。
    assertNoForbiddenContent(eventContentAddressable(content));

    const events = this.load(content.negotiation_id);
    // append-only 违规拒绝：只允许向「校验通过」的既有链追加。被篡改/断链的链
    // 上任何 append 都 fail-closed（不修补、不覆盖、不静默重建）。
    const existing = this.verifyEvents(events);
    if (!existing.valid) {
      throw new LedgerError(
        "ledger_append_only_violation",
        `refusing append to negotiation ${content.negotiation_id}: existing chain invalid (${existing.error?.code} at index ${existing.error?.index})`,
      );
    }

    const tail = events.at(-1);
    const previous_event_digest = tail ? tail.event_digest : null;
    const eventDigest = computeEventDigest(content);

    // 内容寻址去重：同一稳定内容只能在该 negotiation 链上出现一次。
    if (events.some((event) => event.event_digest === eventDigest)) {
      throw new LedgerError(
        "ledger_duplicate_content",
        `event_digest ${eventDigest} already exists in negotiation ${content.negotiation_id}`,
      );
    }

    const event: LedgerEvent = {
      ...content,
      event_id: newLedgerEventId(),
      previous_event_digest,
      event_digest: eventDigest,
      recorded_at: this.now(),
    };

    const filePath = this.filePathFor(content.negotiation_id);
    const nextLines = events.map((e) => JSON.stringify(e)).concat(JSON.stringify(event));
    this.writeFileAtomic(filePath, `${nextLines.join("\n")}\n`);
    return event;
  }

  /**
   * 链完整性校验（§22 verifyChain）。返回结构化结果而非抛错：
   *   corrupt    某行不是合法 JSON / 事件形状（撕裂或手工破坏）
   *   tampered   重算 event_digest 与存储值不一致（内容被改）
   *   chain_break 前一条 digest 不匹配 / 首条非创世（中间删除或链接被改）
   *   duplicate  event_digest 在链内重复
   * 空链（无事件）视为 valid。
   */
  verifyChain(negotiationId: string): LedgerVerifyResult {
    let events: LedgerEvent[];
    try {
      events = this.load(negotiationId);
    } catch (error) {
      if (error instanceof LedgerError && error.code === "ledger_chain_corrupt") {
        const index = error.index ?? 0;
        return { valid: false, count: 0, error: { code: "corrupt", index, detail: error.message } };
      }
      throw error;
    }
    return this.verifyEvents(events);
  }

  /** 对一组事件做链校验（append 与 verifyChain 共用）。 */
  private verifyEvents(events: LedgerEvent[]): LedgerVerifyResult {
    const seen = new Set<string>();
    for (const [index, event] of events.entries()) {
      // 内容篡改检测：重算 digest。
      const recomputed = computeEventDigest(event);
      if (recomputed !== event.event_digest) {
        return {
          valid: false,
          count: events.length,
          error: {
            code: "tampered",
            index,
            detail: `event ${index} digest mismatch: stored ${event.event_digest}, recomputed ${recomputed}`,
          },
        };
      }
      // 链链接：创世必须 previous_event_digest === null；后续必须指向前一条。
      const expectedPrevious = index === 0 ? null : (events[index - 1]?.event_digest ?? null);
      if (event.previous_event_digest !== expectedPrevious) {
        return {
          valid: false,
          count: events.length,
          error: {
            code: "chain_break",
            index,
            detail: `event ${index} previous_event_digest ${event.previous_event_digest} does not link to expected ${expectedPrevious}`,
          },
        };
      }
      // 内容寻址重复检测。
      if (seen.has(event.event_digest)) {
        return {
          valid: false,
          count: events.length,
          error: {
            code: "duplicate",
            index,
            detail: `event_digest ${event.event_digest} repeats at index ${index}`,
          },
        };
      }
      seen.add(event.event_digest);
    }

    return { valid: true, count: events.length };
  }

  /** 所有已落账的 negotiation_id（按文件名扫描）。 */
  listNegotiations(): string[] {
    const dir = this.ensureLedgerDir();
    const ids: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const events = this.loadFromFile(path.join(dir, name));
      const first = events[0];
      if (first) ids.push(first.negotiation_id);
    }
    return ids;
  }

  /** 按 message_id 查重（§23 第 5 步：compare acknowledged messages）。 */
  findByMessageId(messageId: string): { negotiation_id: string; event: LedgerEvent } | null {
    const dir = this.ensureLedgerDir();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const events = this.loadFromFile(path.join(dir, name));
      for (const event of events) {
        if (event.message_id === messageId) {
          return { negotiation_id: event.negotiation_id, event };
        }
      }
    }
    return null;
  }

  /** 内容寻址查询：按 event_digest 取事件（供幂等/审计交叉引用）。 */
  findEventByDigest(negotiationId: string, eventDigest: string): LedgerEvent | null {
    return this.load(negotiationId).find((event) => event.event_digest === eventDigest) ?? null;
  }

  /** 按已落账文件名读取（listNegotiations / findByMessageId 内部复用）。 */
  private loadFromFile(filePath: string): LedgerEvent[] {
    const raw = readFileSync(filePath, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line, i) => this.parseLine(line, i));
  }
}
