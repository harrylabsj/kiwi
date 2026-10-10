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

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { sha256Hex } from "../jcs.js";
// 评审 3-5：原子写复用 fs/atomic-write（文件 + 目录 fsync、失败清理临时文件），
// 与 supervisor/manifest、connect-service 等全仓口径一致，不再维护本地第二实现。
import { writeFileAtomic } from "../../fs/atomic-write.js";
import { LedgerError, computeEventDigest, eventContentAddressable } from "./event.js";
import { assertNoForbiddenContent, isLedgerEvent, newLedgerEventId } from "./event.js";
import type { LedgerEvent, LedgerEventContent, LedgerVerifyResult } from "./event.js";
import { LedgerPayloadSegmentStore } from "./payload-segments.js";
import type { LedgerPayloadSegmentRef } from "./payload-segments.js";

export interface LedgerIdentityPayloadRedactionReport {
  status: "completed" | "restricted";
  matchedNegotiations: number;
  matchedEvents: number;
  redactedSegments: number;
  sharedSegments: number;
  inlinePayloadEvents: number;
  receiptIds: string[];
  limitations: Array<"identity_envelope_retained" | "inline_payload_retained" | "shared_segment_retained">;
}

function requireNonEmptyText(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (text.length === 0 || text.length > 256) {
    throw new LedgerError("ledger_invalid_identity", `${field} must contain 1..256 characters`);
  }
  return text;
}

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
  /** 跨进程 append 锁等待上限（ms，缺省 5000）；超时 fail-closed。 */
  lockTimeoutMs?: number;
  /** Optional external payload store used by appendSegmented. */
  payloadSegments?: LedgerPayloadSegmentStore;
}

/** Main-lock polling interval and minimum age before ESRCH-confirmed recovery. */
const LOCK_POLL_MS = 20;
const LOCK_STALE_MS = 30_000;

/** 锁文件内容：pid 供陈旧判定查活，token 供 finally 只删自己的锁（评审 2-8）。 */
interface ChainLockFile {
  pid: number;
  token: string;
}

/** 进程存活探测（信号 0）；EPERM=存在但无权，视为存活（评审 2-8）。 */
function isProcessAlive(pid: number): boolean {
  // review 2-8（A325 收口）：**只有 ESRCH 确认「合法 PID 持有者不存在」**才
  // 返回 false（可回收）；EPERM=存在无权（活）、EINVAL/越界等错误=身份未知
  // ——一律视为存活，不得当死回收（A322 源审：其余任意错误曾被当 dead）。
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== "ESRCH";
  }
}

/** 读锁文件里的持有者 pid；仅接受**正整数**——负数/浮点/不可解析一律
 * undefined（身份未知 → 陈旧接管逻辑不得删除锁，A317 独验 2-8）。
 * 旧版纯 pid 数字串（正整数）仍兼容。 */
function readLockPid(lockPath: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf-8"));
    const candidate =
      typeof parsed === "number"
        ? parsed
        : parsed !== null && typeof parsed === "object"
          ? (parsed as { pid?: unknown }).pid
          : undefined;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) {
      return candidate;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

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
  private readonly lockTimeoutMs: number;
  private readonly payloadSegments: LedgerPayloadSegmentStore;

  constructor(options: LedgerStoreOptions) {
    this.baseDir = options.dir;
    this.ledgerDir = path.join(options.dir, "ledger");
    this.now = options.now ?? (() => new Date().toISOString());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.payloadSegments = options.payloadSegments ?? new LedgerPayloadSegmentStore({
      dir: path.join(options.dir, "segments"),
      now: this.now,
    });
  }

  /** Main-lock mutations share a short guard. The append itself holds only the
   * main lock. Guard owners are never reclaimed automatically: an unknown or
   * crashed guard blocks this chain until the existing timeout expires.
   * All writers sharing a directory must use this protocol; older writers that
   * bypass the guard are not safe to mix with it. */
  private withChainLock<T>(negotiationId: string, fn: () => T): T {
    const lockPath = path.join(this.ensureLedgerDir(), `${ledgerFileName(negotiationId)}.lock`);
    const guardPath = `${lockPath}.guard`;
    const token = randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;
    const wait = (until: number): void => {
      const remaining = until - Date.now();
      if (remaining <= 0) {
        throw new LedgerError(
          "ledger_append_locked",
          `negotiation ${negotiationId} is locked by another process (waited ${this.lockTimeoutMs}ms)`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(LOCK_POLL_MS, remaining));
    };
    const guarded = <R>(until: number, mutate: () => R): R => {
      const guardToken = randomUUID();
      for (;;) {
        let fd: number;
        try {
          fd = openSync(guardPath, "wx", 0o600);
        } catch (err) {
          if ((err as { code?: string }).code !== "EEXIST") throw err;
          // No PID/age-based deletion of the guard: that would recreate the
          // same compare-unlink race at another level.
          wait(until);
          continue;
        }
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, token: guardToken }));
        } finally {
          closeSync(fd);
        }
        break;
      }
      try {
        return mutate();
      } finally {
        try {
          const owner: unknown = JSON.parse(readFileSync(guardPath, "utf8"));
          if (owner !== null && typeof owner === "object" &&
              (owner as { token?: unknown }).token === guardToken) {
            unlinkSync(guardPath);
          }
        } catch {
          // Preserve an unknown guard. Cleanup must not replace an append
          // result/error or pretend that a committed mutation rolled back.
        }
      }
    };
    const createMainLock = (): void => {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        const lockFile: ChainLockFile = { pid: process.pid, token };
        writeSync(fd, JSON.stringify(lockFile));
      } finally {
        closeSync(fd);
      }
    };
    for (;;) {
      const acquired = guarded(deadline, () => {
        try {
          createMainLock();
          return true;
        } catch (err) {
          if ((err as { code?: string }).code !== "EEXIST") throw err;
        }
        try {
          const st = statSync(lockPath);
          const pid = readLockPid(lockPath);
          if (Date.now() - st.mtimeMs <= LOCK_STALE_MS || pid === undefined || isProcessAlive(pid)) {
            return false;
          }
          // Acquisition, ESRCH-confirmed recovery and release all require this
          // same guard. No compliant acquirer can replace the path between
          // this observation and unlink, or between unlink and our wx.
          unlinkSync(lockPath);
          createMainLock();
          return true;
        } catch (err) {
          if ((err as { code?: string }).code === "ENOENT") return false;
          throw err;
        }
      });
      if (acquired) break;
      // Release the guard before waiting for an active main-lock holder, so
      // its normal release can acquire the guard and make progress.
      wait(deadline);
    }
    try {
      return fn();
    } finally {
      try {
        // A completed append keeps its real result if safe release cannot be
        // obtained. Its main lock remains, blocking subsequent attempts.
        guarded(Date.now() + this.lockTimeoutMs, () => {
          const owner: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
          if (owner !== null && typeof owner === "object" &&
              (owner as { token?: unknown }).token === token) {
            unlinkSync(lockPath);
          }
        });
      } catch {
        // Keep the original fn result/error; do not turn cleanup failure into
        // an apparent pre-effect failure that invites re-execution.
      }
    }
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

  /** 原子写（评审 3-5：复用 fs/atomic-write——文件+目录 fsync、失败清理临时文件）。 */
  private writeFileAtomic(filePath: string, content: string): void {
    writeFileAtomic(filePath, content, { mode: 0o600 });
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

  /** @internal Server-owned identity binding, serialized with the Ledger writer.
   * Remote envelopes cannot supply this record: their content lives only in
   * wire_payload on message_received, never in this local outcome marker. */
  ensureCounterpartyBinding(input: {
    negotiationId: string;
    localIdentity: string;
    senderIdentity: string;
    actor: "buyer" | "merchant";
  }): "bound" | "mismatch" | "unresolved" {
    if (input.actor !== "buyer") return "mismatch";
    const peer = requireNonEmptyText(input.senderIdentity, "sender_identity");
    const local = requireNonEmptyText(input.localIdentity, "local_identity");
    return this.withChainLock(input.negotiationId, () => {
      const events = this.load(input.negotiationId);
      if (!this.verifyEvents(events).valid) {
        throw new LedgerError("ledger_append_only_violation", "identity binding requires a valid Ledger chain");
      }
      const bindings = events.filter((e) => e.event_kind === "reconciliation" &&
        e.identity.sender_identity === local && e.identity.actor === "merchant" &&
        e.wire_payload === undefined && e.message_id === undefined && e.outcome.kind === "ok")
        .map((e) => (e.outcome as { result?: Record<string, unknown> }).result?.peer_binding)
        .filter((b) => b !== undefined);
      if (bindings.length > 0) {
        return bindings.every((b) => b !== null && typeof b === "object" &&
          (b as Record<string, unknown>).type === "merchant-peer-binding" &&
          (b as Record<string, unknown>).version === 1 &&
          (b as Record<string, unknown>).sender_identity === peer &&
          (b as Record<string, unknown>).actor === "buyer") ? "bound" : "mismatch";
      }
      // Legacy ownership is recoverable only from the server pipeline's local
      // authenticated identity snapshot plus its corresponding task receipt.
      // Never infer it from wire.actor, options.counterparty or remote payload.
      const receipts = events.filter((e) => {
        const result = e.outcome.kind === "ok" ? e.outcome.result as Record<string, unknown> : undefined;
        return e.event_kind === "message_received" && e.identity.actor === "buyer" &&
          typeof e.wire_digest === "string" && typeof e.remote_task_id === "string" && result?.task_id === e.remote_task_id;
      });
      if (receipts.length > 0) {
        if (!receipts.every((e) => e.identity.sender_identity === peer)) return "mismatch";
      } else if (events.length > 0) {
        // An old crash may have produced an offer without an inbound receipt.
        // Its owner is not proven; do not let the next caller adopt it.
        return "unresolved";
      }
      this.appendUnlocked({
        event_kind: "reconciliation",
        negotiation_id: input.negotiationId,
        identity: { sender_identity: local, counterparty_identity: peer, actor: "merchant" },
        capability: { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" },
        outcome: { kind: "ok", result: { peer_binding: {
          type: "merchant-peer-binding", version: 1, sender_identity: peer, actor: "buyer",
        } } },
        occurred_at: this.now(),
      });
      return "bound";
    });
  }

  /**
   * Append 一条事件。链接由当前链尾计算；重复内容（同 event_digest）拒绝。
   * 返回完整事件（含 event_id / digests / recorded_at）。
   */
  append(content: LedgerEventContent): LedgerEvent {
    // 跨进程互斥（评审项 B1）：整个 load→verify→rewrite 在链级文件锁内。
    return this.withChainLock(content.negotiation_id, () => this.appendUnlocked(content));
  }

  /**
   * Append an event with large/personal正文 externalized into content-addressed
   * segments. The hash-linked Ledger retains only references and digests.
   */
  appendSegmented(content: LedgerEventContent): LedgerEvent {
    const wireRelative = content.wire_payload === undefined
      ? undefined
      : this.payloadSegments.relativePathFor(content.wire_payload);
    const outcomeRelative = content.outcome.kind === "ok" && content.outcome.result !== undefined
      ? this.payloadSegments.relativePathFor(content.outcome.result)
      : undefined;
    const wireExisted = wireRelative !== undefined && this.payloadSegments.hasPath(wireRelative);
    const outcomeExisted = outcomeRelative !== undefined && this.payloadSegments.hasPath(outcomeRelative);
    const wireRef = content.wire_payload === undefined
      ? undefined
      : this.payloadSegments.put(content.wire_payload);
    const outcomeRef = content.outcome.kind === "ok" && content.outcome.result !== undefined
      ? this.payloadSegments.put(content.outcome.result)
      : undefined;
    const outcome = content.outcome.kind === "ok" && content.outcome.result !== undefined
      ? { kind: "ok" as const }
      : content.outcome;
    const segmented: LedgerEventContent = {
      ...content,
      payload_segments: {
        ...(content.payload_segments ?? {}),
        ...(wireRef === undefined ? {} : { wire_payload: wireRef }),
        ...(outcomeRef === undefined ? {} : { outcome_result: outcomeRef }),
      },
      outcome,
    };
    delete segmented.wire_payload;
    try {
      return this.append(segmented);
    } catch (error) {
      // append performs chain validation and atomic rewrite after segment writes.
      // Remove only files created by this attempt; shared content-addressed files
      // that predated the attempt remain valid for other events.
      if (wireRef !== undefined && !wireExisted) this.payloadSegments.remove(wireRef);
      if (outcomeRef !== undefined && !outcomeExisted) this.payloadSegments.remove(outcomeRef);
      throw error;
    }
  }

  /** Resolve external payload references for trusted recovery/read paths. */
  resolvePayload(event: LedgerEvent): LedgerEvent {
    const refs = event.payload_segments;
    if (refs === undefined) return event;
    const wirePayload = refs.wire_payload === undefined
      ? undefined
      : this.payloadSegments.get<Record<string, unknown>>(refs.wire_payload);
    const outcomeResult = refs.outcome_result === undefined
      ? undefined
      : this.payloadSegments.get<Record<string, unknown>>(refs.outcome_result);
    return {
      ...event,
      ...(wirePayload === undefined ? {} : { wire_payload: wirePayload }),
      ...(outcomeResult === undefined ? {} : { outcome: { kind: "ok", result: outcomeResult } }),
    };
  }

  /**
   * Redact external payloads for one independently verified protocol identity.
   * The caller must derive senderIdentity from the same authenticated
   * principal used to accept the privacy request; request JSON is not a valid
   * source. Event envelopes are never rewritten. Any retained identity,
   * inline payload or shared content-addressed segment makes the report
   * restricted so callers cannot claim full erasure.
   */
  redactPayloadsForIdentity(input: {
    senderIdentity: string;
    redactionId: string;
    redactedAt?: string;
  }): LedgerIdentityPayloadRedactionReport {
    const senderIdentity = requireNonEmptyText(input.senderIdentity, "senderIdentity");
    const redactionId = requireNonEmptyText(input.redactionId, "redactionId");
    const identityMatches = (event: LedgerEvent): boolean =>
      event.identity.sender_identity === senderIdentity ||
      event.identity.counterparty_identity === senderIdentity;
    const allEvents: LedgerEvent[] = [];
    for (const negotiationId of this.listNegotiations()) {
      const events = this.events(negotiationId);
      const verified = this.verifyEvents(events);
      if (!verified.valid) {
        throw new LedgerError(
          "ledger_append_only_violation",
          `refusing privacy redaction for ${negotiationId}: existing chain invalid (${verified.error?.code})`,
        );
      }
      allEvents.push(...events);
    }

    const matchedNegotiations = new Set<string>();
    let matchedEvents = 0;
    let inlinePayloadEvents = 0;
    const usage = new Map<
      string,
      { ref: LedgerPayloadSegmentRef; matched: boolean; unrelated: boolean }
    >();
    for (const event of allEvents) {
      const matched = identityMatches(event);
      if (matched) {
        matchedNegotiations.add(event.negotiation_id);
        matchedEvents += 1;
        if (event.wire_payload !== undefined || (event.outcome.kind === "ok" && event.outcome.result !== undefined)) {
          inlinePayloadEvents += 1;
        }
      }
      const refs = [
        event.payload_segments?.wire_payload,
        event.payload_segments?.outcome_result,
      ].filter((ref): ref is LedgerPayloadSegmentRef => ref !== undefined);
      for (const ref of refs) {
        const prior = usage.get(ref.path);
        if (prior !== undefined && prior.ref.digest !== ref.digest) {
          throw new LedgerError("ledger_chain_corrupt", "conflicting segment digests use the same Ledger path");
        }
        usage.set(ref.path, {
          ref,
          matched: matched || prior?.matched === true,
          unrelated: !matched || prior?.unrelated === true,
        });
      }
    }

    let redactedSegments = 0;
    let sharedSegments = 0;
    const receiptIds: string[] = [];
    for (const item of usage.values()) {
      if (!item.matched) continue;
      if (item.unrelated) {
        sharedSegments += 1;
        continue;
      }
      const receipt = this.payloadSegments.redact(item.ref, {
        redactionId,
        ...(input.redactedAt !== undefined ? { redactedAt: input.redactedAt } : {}),
      });
      redactedSegments += 1;
      receiptIds.push(receipt.receiptId);
    }

    const limitations: LedgerIdentityPayloadRedactionReport["limitations"] = [];
    if (matchedEvents > 0) limitations.push("identity_envelope_retained");
    if (inlinePayloadEvents > 0) limitations.push("inline_payload_retained");
    if (sharedSegments > 0) limitations.push("shared_segment_retained");
    return {
      status: limitations.length === 0 ? "completed" : "restricted",
      matchedNegotiations: matchedNegotiations.size,
      matchedEvents,
      redactedSegments,
      sharedSegments,
      inlinePayloadEvents,
      receiptIds,
      limitations,
    };
  }

  private appendUnlocked(content: LedgerEventContent): LedgerEvent {
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
