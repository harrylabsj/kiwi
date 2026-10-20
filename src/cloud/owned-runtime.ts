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
 * 可选 owned 运行模式（MANAGER-APPROVAL-SCOPE-v2 §B）。
 *
 * 与 SDK / HTTP / Core 无关的**最小持久生命周期**：
 *   - owner 唯一性（journal 代际 + O_EXCL guard）
 *   - 持久计数（业务转发 / MCP / Core 预留，失败不退还）
 *   - window 期限与持久时间锚（provider/host/boot 绑定，未知即 HOLD）
 *   - 终态（到期 / 预算 / 进程内 owner stop）与重启拒绝
 *
 * 本模块不做：外部 stop 通道、跨窗额度迁移、真实业务库与计数跨库原子。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { contentDigest } from "../negotiation/jcs.js";
import { createOwnedClock, ownedHostBootId, type OwnedClock } from "./owned-clock.js";
export { createOwnedClock, ownedHostBootId } from "./owned-clock.js";

/** 运行模式：缺省 off 保持既有行为。 */
export type OwnedMode = "off" | "require";

/** 受信部署方提供的最小策略（全部字段必填，严格校验）。 */
export interface OwnedPolicy {
  version: string;
  policy_id: string;
  window_id: string;
  window_start_utc: string;
  window_end_utc: string;
  caps: { business_requests: number; mcp_calls: number; core_starts: number };
}

export interface OwnedLedger {
  schema: "kiwi.cloud.owned-ledger/1";
  policy_id: string;
  policy_sha256: string;
  window_id: string;
  window_start_utc: string;
  window_end_utc: string;
  caps: { business_requests: number; mcp_calls: number; core_starts: number };
  counts: { business_requests: number; mcp_calls: number; core_starts: number };
  process_boots: number;
  revision: number;
  terminal: boolean;
  terminal_reason: string | null;
  anchor: { provider: string; host_boot_id: string; clock_namespace: string | null; wall_ms: number; monotonic_ns: string };
  updated_at_utc: string;
}

export type OwnedTerminalReason =
  | "OWNER_STOPPED_PERMANENTLY"
  | "RUNTIME_WINDOW_ENDED"
  | "BUSINESS_REQUESTS_EXHAUSTED"
  | "MCP_CALLS_EXHAUSTED"
  | "CORE_STARTS_EXHAUSTED";

export const requireCjs = createRequire(import.meta.url);

const OWNED_DIR = "owned";
export const LEDGER_FILE = "window-ledger.json";
export const GUARD_FILE = "owner.guard";
export const JOURNAL_FILE = "journal.sqlite";

export class OwnedRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message.startsWith(code) ? message : `${code}: ${message}`);
    this.name = "OwnedRuntimeError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new OwnedRuntimeError(code, message);
}

function isSqliteBusy(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database is locked|database table is locked/i.test(String(error));
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonical(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseUtc(value: unknown, field: string): string {
  if (typeof value !== "string") fail("OWNED_POLICY_INVALID", `${field} 必须是 ISO 时间字符串`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail("OWNED_POLICY_INVALID", `${field} 不可解析`);
  return new Date(ms).toISOString();
}

/** 严格校验策略：不填补缺省值、不接受多余语义。 */
export function validateOwnedPolicy(input: unknown, nowMs: number): OwnedPolicy {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("OWNED_POLICY_INVALID", "owned_policy 必须是对象");
  }
  const raw = input as Record<string, unknown>;
  const allowed = ["version", "policy_id", "window_id", "window_start_utc", "window_end_utc", "caps"];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) fail("OWNED_POLICY_INVALID", `owned_policy 含未知字段：${key}`);
  }
  const version = raw.version;
  if (typeof version !== "string" || version.trim() === "") fail("OWNED_POLICY_INVALID", "version 必填");
  const policyId = raw.policy_id;
  if (typeof policyId !== "string" || policyId.trim() === "") fail("OWNED_POLICY_INVALID", "policy_id 必填");
  const windowId = raw.window_id;
  if (typeof windowId !== "string" || windowId.trim() === "") fail("OWNED_POLICY_INVALID", "window_id 必填");
  const startUtc = parseUtc(raw.window_start_utc, "window_start_utc");
  const endUtc = parseUtc(raw.window_end_utc, "window_end_utc");
  if (Date.parse(endUtc) <= Date.parse(startUtc)) {
    fail("OWNED_POLICY_INVALID", "window_end_utc 必须晚于 window_start_utc");
  }
  const capsRaw = raw.caps;
  if (capsRaw === null || typeof capsRaw !== "object" || Array.isArray(capsRaw)) {
    fail("OWNED_POLICY_INVALID", "caps 必须是对象");
  }
  const caps = capsRaw as Record<string, unknown>;
  const capKeys = ["business_requests", "mcp_calls", "core_starts"];
  for (const key of Object.keys(caps)) {
    if (!capKeys.includes(key)) fail("OWNED_POLICY_INVALID", `caps 含未知字段：${key}`);
  }
  for (const key of capKeys) {
    if (!isPositiveInt(caps[key])) fail("OWNED_POLICY_INVALID", `caps.${key} 必须是正整数`);
  }
  // 已过期窗口不允许成为"新"策略，避免用历史夹具开零计数窗口。
  if (Date.parse(endUtc) <= nowMs) fail("OWNED_POLICY_EXPIRED", "window_end_utc 已过");
  return {
    version: version.trim(),
    policy_id: policyId.trim(),
    window_id: windowId.trim(),
    window_start_utc: startUtc,
    window_end_utc: endUtc,
    caps: {
      business_requests: caps.business_requests as number,
      mcp_calls: caps.mcp_calls as number,
      core_starts: caps.core_starts as number,
    },
  };
}

/** 平台能力探针：只在**自建独占**子目录内操作，绝不递归删除既有目录或未知内容。 */
export function probeOwnedCapabilities(parentDir: string): void {
  let probeDir: string | undefined;
  let created = false;
  try {
    const parentStat = statSync(parentDir);
    if (!parentStat.isDirectory()) fail("OWNED_PLATFORM_UNSUPPORTED", `探针父路径不是目录：${parentDir}`);
  } catch (error) {
    fail("OWNED_PLATFORM_UNSUPPORTED", `探针父目录不可用：${(error as Error).message}`);
  }
  try {
    probeDir = path.join(parentDir, `probe-${randomBytes(8).toString("hex")}`);
    // 独占创建：已存在即说明不是"我们自己新建的"，拒绝（不清理他人内容）。
    mkdirSync(probeDir, { mode: 0o700 });
    created = true;
    const file = path.join(probeDir, "cap");
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, "ok");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      openSync(file, "wx", 0o600);
      fail("OWNED_PLATFORM_UNSUPPORTED", "O_EXCL 语义未生效");
    } catch (error) {
      if (error instanceof OwnedRuntimeError) throw error;
    }
    const moved = path.join(probeDir, "cap.moved");
    renameSync(file, moved);
    const dirFd = openSync(probeDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    // 只清理本轮自建且身份可证的对象（独占创建 + 单一已知文件）。
    rmSync(moved, { force: true });
    rmSync(file, { force: true });
  } catch (error) {
    if (error instanceof OwnedRuntimeError) throw error;
    fail("OWNED_PLATFORM_UNSUPPORTED", `持久能力探针失败：${(error as Error).message}`);
  } finally {
    if (created && probeDir !== undefined) {
      try {
        // 只用 rmdir：非空（出现未知内容）就保持原样，绝不递归删除。
        rmdirSync(probeDir);
      } catch {
        // 非空或无法删除：保留原样，不强行递归删除（未知内容一律不动）。
      }
    }
  }
}

export interface OwnedJournalState {
  generation: number;
  token_hash: string;
  held: number;
  pending_json: string | null;
  dispatch_json: string | null;
  last_ledger_sha256: string | null;
}

export interface OwnedOwnerIdentity {
  tokenHash: string;
  pid: number;
  hostBootId: string;
  atMs: number;
}

/** 待完成操作：必须自带 base/target 摘要与所有者身份，恢复时逐项核验。 */
export interface OwnedPendingOperation {
  schema: "kiwi.cloud.owned-pending/1";
  operation_id: string;
  kind: "terminal" | "count";
  generation: number;
  token_hash: string;
  base_sha256: string;
  target_sha256: string;
  target_json: string;
}

/**
 * 最小 SQLite journal：owner 所有权（held + token）与操作意图。
 *
 * 所有权 CAS 只在 SQL 里做：`UPDATE ... WHERE held=0 OR token_hash=<观察到的旧 token>`，
 * 单语句原子，且**只处置被观察的对象**（旧 token），不做"先读再按路径删除"。
 */
export class OwnedJournal {
  private constructor(
    private readonly db: { exec: (sql: string) => void; prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => { changes?: number | bigint } }; close: () => void },
    readonly dbPath: string,
  ) {}

  static open(dbPath: string): OwnedJournal {
    let sqlite: { DatabaseSync: new (p: string) => unknown };
    try {
      sqlite = requireCjs("node:sqlite") as { DatabaseSync: new (p: string) => unknown };
    } catch {
      fail("OWNED_PLATFORM_UNSUPPORTED", "node:sqlite 不可用");
    }
    const db = new (sqlite.DatabaseSync as new (p: string) => {
      exec: (sql: string) => void;
      prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => { changes?: number | bigint } };
      close: () => void;
    })(dbPath);
    const journal = new OwnedJournal(db, dbPath);
    journal.migrate();
    return journal;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_state (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        generation         INTEGER NOT NULL,
        token_hash         TEXT NOT NULL,
        held               INTEGER NOT NULL DEFAULT 0,
        owner_pid          INTEGER,
        owner_boot         TEXT,
        owner_at_ms        INTEGER,
        pending_json       TEXT,
        dispatch_json      TEXT,
        last_ledger_sha256 TEXT
      );
    `);
    const cols = this.db.prepare("PRAGMA table_info(owner_state)").all() as Array<{ name: string }>;
    for (const [name, ddl] of [
      ["held", "ALTER TABLE owner_state ADD COLUMN held INTEGER NOT NULL DEFAULT 0"],
      ["owner_pid", "ALTER TABLE owner_state ADD COLUMN owner_pid INTEGER"],
      ["owner_boot", "ALTER TABLE owner_state ADD COLUMN owner_boot TEXT"],
      ["owner_at_ms", "ALTER TABLE owner_state ADD COLUMN owner_at_ms INTEGER"],
    ] as const) {
      if (!cols.some((c) => c.name === name)) this.db.exec(ddl);
    }
  }

  state(): OwnedJournalState | undefined {
    const row = this.db
      .prepare(
        "SELECT generation, token_hash, held, pending_json, dispatch_json, last_ledger_sha256 FROM owner_state WHERE id = 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      generation: Number(row.generation),
      token_hash: String(row.token_hash),
      held: Number(row.held ?? 0),
      pending_json: row.pending_json === null ? null : String(row.pending_json),
      dispatch_json: row.dispatch_json === null ? null : String(row.dispatch_json),
      last_ledger_sha256: row.last_ledger_sha256 === null ? null : String(row.last_ledger_sha256),
    };
  }

  /**
   * 取得所有权（原子）。
   * - 全新：INSERT（主键冲突即另一进程已建）；
   * - 空闲：held=0 时抢占；
   * - 接管：仅当 held=1 且 token_hash 正好等于**观察到的旧 token**（调用方已证明其 owner 已死）。
   * 任何其它情形 changes=0 → 失败，调用方必须 HOLD/BUSY，不得再改任何文件。
   */
  acquire(identity: OwnedOwnerIdentity, observedTokenHash?: string): number {
    const current = this.state();
    if (current === undefined) {
      try {
        this.db
          .prepare(
            "INSERT INTO owner_state (id, generation, token_hash, held, owner_pid, owner_boot, owner_at_ms) VALUES (1, 1, ?, 1, ?, ?, ?)",
          )
          .run(identity.tokenHash, identity.pid, identity.hostBootId, identity.atMs);
      } catch {
        fail("OWNED_RUNTIME_OWNER_BUSY", "并发首启：owner 行已被创建");
      }
      return 1;
    }
    const next = current.generation + 1;
    const result =
      observedTokenHash === undefined
        ? this.db
            .prepare(
              "UPDATE owner_state SET generation = ?, token_hash = ?, held = 1, owner_pid = ?, owner_boot = ?, owner_at_ms = ? WHERE id = 1 AND held = 0",
            )
            .run(next, identity.tokenHash, identity.pid, identity.hostBootId, identity.atMs)
        : this.db
            .prepare(
              "UPDATE owner_state SET generation = ?, token_hash = ?, held = 1, owner_pid = ?, owner_boot = ?, owner_at_ms = ? WHERE id = 1 AND held = 1 AND token_hash = ?",
            )
            .run(next, identity.tokenHash, identity.pid, identity.hostBootId, identity.atMs, observedTokenHash);
    if (Number(result.changes ?? 0) !== 1) {
      fail(
        "OWNED_RUNTIME_OWNER_BUSY",
        observedTokenHash === undefined
          ? "owner 仍被持有（held=1），拒绝第二 owner"
          : "观察到的 owner 已变化，拒绝基于旧观察的接管",
      );
    }
    return next;
  }

  /** 释放：只释放自己的 token（不按路径、不按时间猜测）。 */
  release(tokenHash: string): void {
    this.db.prepare("UPDATE owner_state SET held = 0 WHERE id = 1 AND token_hash = ? AND held = 1").run(tokenHash);
  }

  /** 每次写账本前确认自己仍是 owner（fencing）。 */
  assertOwner(tokenHash: string): void {
    const row = this.db.prepare("SELECT held, token_hash FROM owner_state WHERE id = 1").get() as
      | { held?: unknown; token_hash?: unknown }
      | undefined;
    if (row === undefined || Number(row.held ?? 0) !== 1 || String(row.token_hash) !== tokenHash) {
      fail("OWNED_RUNTIME_OWNER_FENCED", "已不是当前 owner，拒绝写入");
    }
  }

  setPending(operation: OwnedPendingOperation): void {
    const result = this.db
      .prepare("UPDATE owner_state SET pending_json = ? WHERE id = 1 AND pending_json IS NULL AND held = 1 AND token_hash = ?")
      .run(JSON.stringify(operation), operation.token_hash);
    if (Number(result.changes ?? 0) !== 1) fail("OWNED_PENDING_EXISTS", "已有未完成的 journal 操作或已非 owner");
  }

  pending(): OwnedPendingOperation | undefined {
    const state = this.state();
    if (state?.pending_json === null || state?.pending_json === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(state.pending_json);
    } catch {
      fail("OWNED_JOURNAL_CORRUPT", "pending 记录不是合法 JSON");
    }
    const value = parsed as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    const expected = [
      "base_sha256", "generation", "kind", "operation_id", "schema", "target_json", "target_sha256", "token_hash",
    ];
    if (JSON.stringify(keys) !== JSON.stringify(expected)) fail("OWNED_JOURNAL_CORRUPT", "pending 字段集不符");
    if (value.schema !== "kiwi.cloud.owned-pending/1") fail("OWNED_JOURNAL_CORRUPT", "pending schema 不符");
    for (const key of ["operation_id", "base_sha256", "target_sha256", "target_json", "token_hash"]) {
      if (typeof value[key] !== "string" || (value[key] as string).length === 0) {
        fail("OWNED_JOURNAL_CORRUPT", `pending.${key} 非法`);
      }
    }
    if (!isPositiveInt(value.generation)) fail("OWNED_JOURNAL_CORRUPT", "pending.generation 非法");
    if (value.kind !== "terminal" && value.kind !== "count") fail("OWNED_JOURNAL_CORRUPT", "pending.kind 非法");
    return value as unknown as OwnedPendingOperation;
  }

  /** 最终确认：清 pending 并记录账本摘要，只在账本写入+读回之后调用。 */
  finalize(ledgerSha256: string): void {
    const result = this.db
      .prepare("UPDATE owner_state SET pending_json = NULL, last_ledger_sha256 = ? WHERE id = 1")
      .run(ledgerSha256);
    if (Number(result.changes ?? 0) !== 1) fail("OWNED_JOURNAL_FINALIZE", "journal 最终确认失败");
  }

  close(): void {
    this.db.close();
  }
}

export interface OwnedStateLayout {
  dir: string;
  ledger: string;
  guard: string;
  journal: string;
}

export function ownedLayout(dataDir: string): OwnedStateLayout {
  const dir = path.join(dataDir, OWNED_DIR);
  return {
    dir,
    ledger: path.join(dir, LEDGER_FILE),
    guard: path.join(dir, GUARD_FILE),
    journal: path.join(dir, JOURNAL_FILE),
  };
}

/** 数据目录分类：只有"全新空目录"可初始化。 */
export type OwnedDataDirClass = "FRESH" | "ACTIVE" | "LEGACY" | "PARTIAL";

export function classifyDataDir(dataDir: string, layout: OwnedStateLayout): OwnedDataDirClass {
  const ownedExists = existsSync(layout.dir);
  let dataDirEntries: string[] = [];
  try {
    dataDirEntries = existsSync(dataDir)
      ? (requireCjs("node:fs").readdirSync(dataDir) as string[]).filter((name: string) => name !== OWNED_DIR)
      : [];
  } catch {
    fail("OWNED_DATA_DIR_UNREADABLE", `无法读取 dataDir：${dataDir}`);
  }
  if (!ownedExists) return dataDirEntries.length === 0 ? "FRESH" : "LEGACY";
  const required = [layout.ledger, layout.journal];
  const allThere = required.every((file) => existsSync(file));
  if (!allThere) return "PARTIAL";
  return "ACTIVE";
}

// ---------------------------------------------------------------------------
// 运行时编排：owner → anchor → 计数 → bootstrap → 终态/关闭
// ---------------------------------------------------------------------------

export interface OwnedStatus {
  policy_id: string;
  window_id: string;
  window_start_utc: string;
  window_end_utc: string;
  counts: OwnedLedger["counts"];
  caps: OwnedLedger["caps"];
  process_boots: number;
  terminal: boolean;
  terminal_reason: string | null;
}

export interface OwnedStopResult {
  status: "TERMINAL_CONFIRMED" | "HOLD";
  reason?: OwnedTerminalReason;
  revision?: number;
  ledger_sha256?: string;
  code?: string;
}

export interface OwnedCloseResult {
  status: "CLOSED" | "HOLD";
  terminal?: boolean;
  code?: string;
}

export interface OwnedRuntimeOptions<T> {
  dataDir: string;
  policy: OwnedPolicy;
  /** 在 owner/计数/期限全部就绪后才调用；返回值交给调用方。 */
  bootstrap: () => Promise<T>;
  /** 关闭底层实例（SDK/服务器）；只在终态读回后调用。 */
  closeInstance?: (value: T) => Promise<void> | void;
  now?: () => number;
  crashHook?: (phase: string) => void;
  probeDir?: string;
  clock?: OwnedClock;
}

export interface OwnedRuntimeHandle<T> {
  readonly value: T;
  status(): OwnedStatus;
  isClosing(): boolean;
  forwardingEnabled(): boolean;
  reserveBusiness(): void;
  reserveMcp(): void;
  reserveCore(): void;
  close(): Promise<OwnedCloseResult>;
  stopPermanently(): Promise<OwnedStopResult>;
}

function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function atomicWrite(target: string, bytes: Buffer): void {
  const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  const dirFd = openSync(path.dirname(target), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

const LEDGER_KEYS = [
  "schema", "policy_id", "policy_sha256", "window_id", "window_start_utc", "window_end_utc",
  "caps", "counts", "process_boots", "revision", "terminal", "terminal_reason", "anchor", "updated_at_utc",
];
const COUNT_KEYS = ["business_requests", "mcp_calls", "core_starts"];
const TERMINAL_REASONS: readonly OwnedTerminalReason[] = [
  "OWNER_STOPPED_PERMANENTLY", "RUNTIME_WINDOW_ENDED", "BUSINESS_REQUESTS_EXHAUSTED",
  "MCP_CALLS_EXHAUSTED", "CORE_STARTS_EXHAUSTED",
];

/** 账本语义门：所有真实入口共用，未知终态/计数/时间锚一律在副作用前 HOLD。 */
function assertLedgerSemantic(value: unknown, policy?: OwnedPolicy, nowMs?: number): asserts value is OwnedLedger {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("OWNED_RUNTIME_STATE_UNKNOWN", "账本语义不是对象");
  const raw = value as Record<string, unknown>;
  const caps = raw.caps as Record<string, unknown>;
  const counts = raw.counts as Record<string, unknown>;
  for (const key of COUNT_KEYS) {
    if (!isPositiveInt(caps?.[key])) fail("OWNED_LEDGER_BOUNDS", `caps.${key} 非法`);
    if (!Number.isSafeInteger(counts?.[key]) || (counts[key] as number) < 0 || (counts[key] as number) > (caps[key] as number)) {
      fail("OWNED_LEDGER_BOUNDS", `counts.${key} 非法`);
    }
  }
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) fail("OWNED_LEDGER_BOUNDS", "revision 非法");
  if (!Number.isSafeInteger(raw.process_boots) || (raw.process_boots as number) < 1) fail("OWNED_LEDGER_BOUNDS", "process_boots 非法");
  if (typeof raw.terminal !== "boolean") fail("OWNED_LEDGER_BOUNDS", "terminal 非布尔");
  if (raw.terminal) {
    if (typeof raw.terminal_reason !== "string" || !TERMINAL_REASONS.includes(raw.terminal_reason as OwnedTerminalReason)) {
      fail("OWNED_RUNTIME_TERMINAL_REASON_UNKNOWN", "终态理由未知");
    }
  } else if (raw.terminal_reason !== null) {
    fail("OWNED_LEDGER_BOUNDS", "非终态不得携带 terminal_reason");
  }
  if (raw.terminal) {
    const reason = raw.terminal_reason as OwnedTerminalReason;
    if (reason === "BUSINESS_REQUESTS_EXHAUSTED" && (counts.business_requests as number) < (caps.business_requests as number)) {
      fail("OWNED_RUNTIME_TERMINAL_REASON_INCONSISTENT", "业务终态理由与计数不相容");
    }
    if (reason === "MCP_CALLS_EXHAUSTED" && (counts.mcp_calls as number) < (caps.mcp_calls as number)) {
      fail("OWNED_RUNTIME_TERMINAL_REASON_INCONSISTENT", "MCP终态理由与计数不相容");
    }
    if (reason === "CORE_STARTS_EXHAUSTED" && (counts.core_starts as number) < (caps.core_starts as number)) {
      fail("OWNED_RUNTIME_TERMINAL_REASON_INCONSISTENT", "Core终态理由与计数不相容");
    }
    if (reason === "RUNTIME_WINDOW_ENDED" && policy !== undefined && nowMs !== undefined && nowMs < Date.parse(policy.window_end_utc)) {
      fail("OWNED_RUNTIME_TERMINAL_REASON_INCONSISTENT", "到期终态理由与当前窗口不相容");
    }
  }
  const anchor = raw.anchor as Record<string, unknown>;
  if (
    anchor === null || typeof anchor !== "object" ||
    !(["DARWIN_MACH_CONTINUOUS_NS", "LINUX_PROC_UPTIME_NS"] as string[]).includes(String(anchor.provider)) ||
    typeof anchor.host_boot_id !== "string" || anchor.host_boot_id.length === 0 ||
    (typeof anchor.clock_namespace !== "string" && anchor.clock_namespace !== null) ||
    !Number.isSafeInteger(anchor.wall_ms) || typeof anchor.monotonic_ns !== "string" || !/^\d+$/.test(anchor.monotonic_ns)
  ) fail("OWNED_RUNTIME_CLOCK_IDENTITY_UNKNOWN", "持久时间锚语义未知");
}

/**
 * 重启前校验：journal 记录的账本摘要、精确键集、数值范围、计数不超上限、
 * 以及**完整不可变策略**（含 caps/起止，经 policy_sha256）与路径身份绑定。
 * 任何漂移都在副作用前 HOLD。
 */
function assertLedgerIntegrity(
  ledger: unknown,
  journalState: OwnedJournalState | undefined,
  ledgerPath: string,
  policy: OwnedPolicy,
): asserts ledger is OwnedLedger {
  if (ledger === null || typeof ledger !== "object" || Array.isArray(ledger)) {
    fail("OWNED_RUNTIME_STATE_UNKNOWN", "ledger 不是对象");
  }
  const value = ledger as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...LEDGER_KEYS].sort())) {
    fail("OWNED_LEDGER_SCHEMA_DRIFT", `ledger 键集不符：${keys.join(",")}`);
  }
  if (value.schema !== "kiwi.cloud.owned-ledger/1") fail("OWNED_LEDGER_SCHEMA_DRIFT", "ledger schema 不符");
  assertLedgerSemantic(value, policy);
  // 可信摘要：journal 必须记录与磁盘一致的内容摘要。
  const bytes = readFileSync(ledgerPath);
  const actual = sha256(bytes);
  if (journalState?.last_ledger_sha256 !== actual) {
    fail("OWNED_LEDGER_DRIFT", "journal 记录的账本摘要与磁盘不一致");
  }
  // 完整不可变策略绑定（含 caps / 起止），不是只看 id。
  if (value.policy_id !== policy.policy_id || value.window_id !== policy.window_id) {
    fail("OWNED_RUNTIME_POLICY_DRIFT", "策略与既有窗口不一致（不允许换窗/换策略）");
  }
  if (value.policy_sha256 !== contentDigest(policy)) {
    fail("OWNED_RUNTIME_POLICY_DRIFT", "策略内容漂移（caps/期限等被改动）");
  }
  if (value.window_start_utc !== policy.window_start_utc || value.window_end_utc !== policy.window_end_utc) {
    fail("OWNED_RUNTIME_POLICY_DRIFT", "窗口起止与策略不一致");
  }
  // 数值范围与计数不超上限。
  const caps = value.caps as Record<string, unknown>;
  const counts = value.counts as Record<string, unknown>;
  for (const key of COUNT_KEYS) {
    const cap = caps?.[key];
    const used = counts?.[key];
    if (!isPositiveInt(cap)) fail("OWNED_LEDGER_BOUNDS", `caps.${key} 非法`);
    if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) {
      fail("OWNED_LEDGER_BOUNDS", `counts.${key} 非法`);
    }
    if (used > (cap as number)) fail("OWNED_LEDGER_BOUNDS", `counts.${key} 超过上限`);
    if (cap !== policy.caps[key as keyof OwnedPolicy["caps"]]) {
      fail("OWNED_RUNTIME_POLICY_DRIFT", `caps.${key} 与策略不一致`);
    }
  }
}

/** pending 恢复：只有完整匹配 base/target 与 delta 时才前向应用，否则保留原文件 HOLD。 */
function recoverPending(
  pending: OwnedPendingOperation,
  ledgerPath: string,
  generation: number,
  tokenHash: string,
  journal: OwnedJournal,
): void {
  // pending 必须属于"我们刚刚接管的那个 owner/代际"，否则拒绝应用。
  if (pending.generation !== generation || pending.token_hash !== tokenHash) {
    fail("OWNED_RUNTIME_PENDING_FOREIGN", "pending 属于其他 owner/代际，拒绝应用");
  }
  if (!existsSync(ledgerPath)) fail("OWNED_RUNTIME_PENDING_NO_BASE", "pending 存在但账本缺失");
  const currentBytes = readFileSync(ledgerPath);
  const currentSha = sha256(currentBytes);
  if (currentSha === pending.target_sha256) {
    // 已达目标：只需最终确认。
    if (!canonical(JSON.parse(pending.target_json)).equals(currentBytes)) {
      fail("OWNED_RUNTIME_PENDING_TARGET_MISMATCH", "目标摘要相同但字节不一致");
    }
    finalizePendingAfterCheck(ledgerPath, currentBytes);
    journal.finalize(sha256(currentBytes));
    return;
  }
  if (currentSha !== pending.base_sha256) {
    fail("OWNED_RUNTIME_PENDING_BASE_MISMATCH", "当前账本不处于允许的 base/target 状态");
  }
  const base = JSON.parse(currentBytes.toString("utf8")) as OwnedLedger;
    assertLedgerSemantic(base);
  const targetBytes = Buffer.from(pending.target_json, "utf8");
  if (sha256(targetBytes) !== pending.target_sha256) {
    fail("OWNED_RUNTIME_PENDING_TARGET_MISMATCH", "target_json 与 target_sha256 不符");
  }
  const target = JSON.parse(targetBytes.toString("utf8")) as OwnedLedger;
  assertLedgerSemantic(target);
  assertDeltaAllowed(base, target, pending.kind);
  if (!canonical(JSON.parse(targetBytes.toString("utf8"))).equals(targetBytes)) {
    fail("OWNED_RUNTIME_PENDING_TARGET_MISMATCH", "target_json 非规范序列化");
  }
  finalizePendingAfterCheck(ledgerPath, targetBytes);
  journal.finalize(sha256(targetBytes));
}

function finalizePendingAfterCheck(ledgerPath: string, bytes: Buffer): void {
  atomicWrite(ledgerPath, bytes);
  const readBack = readFileSync(ledgerPath);
  if (!readBack.equals(bytes)) fail("OWNED_RUNTIME_PENDING_READBACK", "恢复写回不一致");
}

/** 允许的 delta：计数只增不退、策略/anchor/window 不变、revision 恰好 +1、终态理由合法。 */
function assertDeltaAllowed(base: OwnedLedger, target: OwnedLedger, kind: OwnedPendingOperation["kind"]): void {
  if (target.schema !== "kiwi.cloud.owned-ledger/1") fail("OWNED_RUNTIME_PENDING_DELTA", "target schema 不符");
  if (target.policy_sha256 !== base.policy_sha256 || target.policy_id !== base.policy_id || target.window_id !== base.window_id) {
    fail("OWNED_RUNTIME_PENDING_DELTA", "pending 试图改变策略绑定");
  }
  if (JSON.stringify(target.anchor) !== JSON.stringify(base.anchor)) {
    fail("OWNED_RUNTIME_PENDING_DELTA", "pending 试图改变时间锚");
  }
  if (target.window_start_utc !== base.window_start_utc || target.window_end_utc !== base.window_end_utc) {
    fail("OWNED_RUNTIME_PENDING_DELTA", "pending 试图改变窗口");
  }
  if (JSON.stringify(target.caps) !== JSON.stringify(base.caps)) {
    fail("OWNED_RUNTIME_PENDING_DELTA", "pending 试图改变上限");
  }
  if (target.revision !== base.revision + 1) fail("OWNED_RUNTIME_PENDING_DELTA", "pending revision 非法");
  if (Date.parse(target.updated_at_utc) < Date.parse(base.updated_at_utc)) {
    fail("OWNED_RUNTIME_PENDING_DELTA", "pending 时间倒退");
  }
  for (const key of ["business_requests", "mcp_calls", "core_starts"] as const) {
    const before = base.counts[key];
    const after = target.counts[key];
    if (!Number.isSafeInteger(after) || after < before) {
      fail("OWNED_RUNTIME_PENDING_DELTA", `pending 使 ${key} 倒退`);
    }
    if (after > base.caps[key]) fail("OWNED_RUNTIME_PENDING_DELTA", `pending 使 ${key} 超上限`);
  }
  if (base.terminal && !target.terminal) fail("OWNED_RUNTIME_PENDING_DELTA", "pending 试图撤销终态");
  if (!base.terminal && target.terminal) {
    if (kind !== "terminal") fail("OWNED_RUNTIME_PENDING_DELTA", "非 terminal 操作不得写终态");
    if (typeof target.terminal_reason !== "string" || !TERMINAL_REASONS.includes(target.terminal_reason as OwnedTerminalReason)) {
      fail("OWNED_RUNTIME_PENDING_DELTA", "终态理由不在白名单");
    }
  }
  if (target.process_boots !== base.process_boots) {
    fail("OWNED_RUNTIME_PENDING_DELTA", "pending 试图改变 process_boots");
  }
}

export async function startOwnedRuntime<T>(options: OwnedRuntimeOptions<T>): Promise<OwnedRuntimeHandle<T>> {
  const { dataDir, policy } = options;
  const now = options.now ?? Date.now;
  const clock = options.clock ?? createOwnedClock();
  const clockIdentity = clock.identity;
  const layout = ownedLayout(dataDir);
  const crashHook = options.crashHook ?? (() => {});

  const dataClass = classifyDataDir(dataDir, layout);
  if (dataClass === "LEGACY") {
    fail("OWNED_RUNTIME_LEGACY_STATE", `dataDir 非空且无 owned 状态，拒绝初始化：${dataDir}`);
  }
  if (dataClass === "FRESH") {
    // 全新：先确保 dataDir 自身存在（0700）；owned/ 随后独占创建。
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      fail("OWNED_DATA_DIR_UNWRITABLE", `无法创建 dataDir：${(error as Error).message}`);
    }
  }
  // 能力探针：只在 dataDir 下自建**独占随机子目录**，只清理该子目录（非递归、且仅自有对象）。
  probeOwnedCapabilities(options.probeDir ?? dataDir);

  if (dataClass === "FRESH") {
    try {
      mkdirSync(layout.dir, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        fail("OWNED_RUNTIME_CONCURRENT_INIT", "并发首启：owned 目录已被创建");
      }
      throw error;
    }
  }

  // guard：同一时刻只允许一个 owner 进入；身份（host boot + pid + 代际）随 guard 落盘，
  // 只有"同一 host boot 且该 pid 已不存在"才视为可证明的 dead owner，可接管；
  // 未知身份（跨 boot / 解析失败 / guard 损坏）一律 HOLD，不按 mtime 或超时清锁。
  const token = randomBytes(16).toString("hex");
  const tokenHash = sha256(token);
  const hostBootId = ownedHostBootId(clockIdentity);
  const guardBody = (generation: number): string =>
    `${JSON.stringify({ schema: "kiwi.cloud.owned-owner-guard/1", token_hash: tokenHash, host_boot_id: hostBootId, pid: process.pid, generation, at_ms: now() })}\n`;

  /** 读取既有 guard 并判定其 owner 是否可证明已死；结构未知一律 HOLD。 */
  const readGuard = (): { token_hash: string; generation: number; dead: boolean } | undefined => {
    if (!existsSync(layout.guard)) return undefined;
    let existing: { schema?: string; host_boot_id?: string; pid?: number; generation?: number; token_hash?: string } | undefined;
    try {
      existing = JSON.parse(readFileSync(layout.guard, "utf8")) as typeof existing;
    } catch {
      fail("OWNED_RUNTIME_UNKNOWN_OWNER", "owner guard 损坏，无法判定存活");
    }
    if (
      existing === undefined ||
      existing.schema !== "kiwi.cloud.owned-owner-guard/1" ||
      typeof existing.host_boot_id !== "string" ||
      typeof existing.pid !== "number" ||
      typeof existing.generation !== "number" ||
      typeof existing.token_hash !== "string"
    ) {
      fail("OWNED_RUNTIME_UNKNOWN_OWNER", "owner guard 结构未知，拒绝接管");
    }
    if (existing.host_boot_id !== hostBootId) {
      fail("OWNED_RUNTIME_UNKNOWN_OWNER", "owner 来自不同 host boot，无法证明已死");
    }
    let alive = true;
    try {
      process.kill(existing.pid, 0);
    } catch (error) {
      alive = (error as { code?: string }).code === "EPERM";
    }
    return { token_hash: existing.token_hash, generation: existing.generation, dead: !alive };
  };
  let guardFd: number | undefined;
  /** guard 仅作诊断标记（所有权在 SQL）；写入失败不授予/撤销所有权。 */
  const writeGuard = (generation: number): void => {
    try {
      if (guardFd !== undefined) closeSync(guardFd);
      if (existsSync(layout.guard)) {
        renameSync(layout.guard, `${layout.guard}.stale-${Date.now()}`);
      }
      guardFd = openSync(layout.guard, "w", 0o600);
      writeSync(guardFd, guardBody(generation));
      fsyncSync(guardFd);
    } catch (error) {
      fail("OWNED_RUNTIME_GUARD_WRITE", `guard 写入失败：${(error as Error).message}`);
    }
  };

  if (dataClass === "PARTIAL") {
    fail("OWNED_RUNTIME_STATE_UNKNOWN", `owned 状态不完整：${layout.dir}`);
  }

  let journal: OwnedJournal;
  try {
    journal = OwnedJournal.open(layout.journal);
  } catch (error) {
    if (isSqliteBusy(error)) fail("OWNED_RUNTIME_OWNER_BUSY", "SQLite owner journal 正在被其他 owner 写入");
    throw error;
  }
  let ownerReleased = false;
  let acquiredOwner = false;
  const releaseOwner = (): void => {
    if (ownerReleased) return;
    ownerReleased = true;
    // 只有真正取得过所有权才释放/清理 guard；失败路径保留现场（不清他人的锁）。
    if (acquiredOwner) {
      try {
        if (guardFd !== undefined) closeSync(guardFd);
      } catch {
        /* ignore */
      }
      try {
        rmSync(layout.guard, { force: true });
      } catch {
        /* ignore */
      }
      journal.release(tokenHash);
    }
    journal.close();
  };

  try {
    // 所有权：SQL CAS。held=0 → 抢占；held=1 但观察到的是可证明已死的旧 token → 接管。
    const observed = readGuard();
    if (observed !== undefined && !observed.dead) {
      fail("OWNED_RUNTIME_OWNER_BUSY", "guard 显示 owner 仍存活，拒绝启动");
    }
    const prior = journal.state();
    // 只有 journal 标记 held=1 时才走"基于观察旧 token 的接管 CAS"；
    // 否则是空闲状态，用 held=0 抢占。
    const observedToken =
      prior !== undefined && prior.held === 1 && observed !== undefined ? observed.token_hash : undefined;
    if (prior !== undefined && prior.held === 1 && observedToken !== prior.token_hash) {
      fail("OWNED_RUNTIME_UNKNOWN_OWNER", "guard 与 journal 的 owner 不一致，拒绝接管");
    }
    let generation: number;
    try {
      generation = journal.acquire(
        { tokenHash, pid: process.pid, hostBootId, atMs: now() },
        observedToken,
      );
    } catch (error) {
      if (isSqliteBusy(error)) fail("OWNED_RUNTIME_OWNER_BUSY", "SQLite owner journal 正在被其他 owner 写入");
      throw error;
    }
    acquiredOwner = true;
    const clockSample = clock.read();
    const pending = journal.pending();
    if (pending !== undefined) {
      recoverPending(pending, layout.ledger, prior!.generation, prior!.token_hash, journal);
      crashHook("recovered-pending");
    }

    const startMs = now();
    if (startMs >= Date.parse(policy.window_end_utc)) {
      fail("OWNED_RUNTIME_WINDOW_EXPIRED", "策略窗口已结束");
    }
    if (startMs < Date.parse(policy.window_start_utc)) {
      fail("OWNED_RUNTIME_WINDOW_NOT_STARTED", "策略窗口尚未开始");
    }

    const ledgerPath = layout.ledger;
    let ledger: OwnedLedger;
    if (!existsSync(ledgerPath)) {
      ledger = {
        schema: "kiwi.cloud.owned-ledger/1",
        policy_id: policy.policy_id,
        policy_sha256: contentDigest(policy),
        window_id: policy.window_id,
        window_start_utc: policy.window_start_utc,
        window_end_utc: policy.window_end_utc,
        caps: { ...policy.caps },
        counts: { business_requests: 0, mcp_calls: 0, core_starts: 0 },
        process_boots: generation,
        revision: 0,
        terminal: false,
        terminal_reason: null,
        anchor: {
          provider: clockIdentity.provider,
          host_boot_id: hostBootId,
          clock_namespace: clockIdentity.namespace,
          wall_ms: startMs,
          monotonic_ns: clockSample.monotonicNs,
        },
        updated_at_utc: new Date(startMs).toISOString(),
      };
      atomicWrite(ledgerPath, canonical(ledger));
      journal.finalize(sha256(canonical(ledger)));
      writeGuard(generation);
    } else {
      ledger = readJsonFile(ledgerPath) as OwnedLedger;
      assertLedgerIntegrity(ledger, journal.state(), ledgerPath, policy);
      const anchor = ledger.anchor;
      if (anchor.provider !== clockIdentity.provider || anchor.host_boot_id !== hostBootId || anchor.clock_namespace !== clockIdentity.namespace) {
        fail("OWNED_RUNTIME_CLOCK_IDENTITY_DRIFT", "持久时间锚与当前 host/boot/provider/namespace 不一致");
      }
      assertLedgerSemantic(ledger, policy, startMs);
      if (ledger.terminal) {
        fail("OWNED_RUNTIME_STOPPED_PERMANENTLY", `窗口已终态：${ledger.terminal_reason ?? "UNKNOWN"}`);
      }
      ledger = {
        ...ledger,
        process_boots: generation,
        revision: ledger.revision + 1,
        updated_at_utc: new Date(startMs).toISOString(),
      };
      atomicWrite(ledgerPath, canonical(ledger));
      journal.finalize(sha256(canonical(ledger)));
      writeGuard(generation);
    }

    let closing = false;
    let forwarding = true;

    const persist = (mutate: (current: OwnedLedger) => OwnedLedger): OwnedLedger => {
      clock.read();
      const current = readJsonFile(ledgerPath) as OwnedLedger;
      assertLedgerSemantic(current, policy, now());
      if (current.terminal) fail("OWNED_RUNTIME_TERMINAL", "窗口已终态，拒绝写入");
      journal.assertOwner(tokenHash);
      const next = mutate({ ...current, revision: current.revision + 1, updated_at_utc: new Date(now()).toISOString() });
      atomicWrite(ledgerPath, canonical(next));
      journal.finalize(sha256(canonical(next)));
      return next;
    };

    const terminal = (reason: OwnedTerminalReason): OwnedLedger => {
      clock.read();
      const current = readJsonFile(ledgerPath) as OwnedLedger;
      assertLedgerSemantic(current, policy, now());
      if (current.terminal) {
        if (current.terminal_reason === reason) return current;
        fail("OWNED_RUNTIME_TERMINAL_REASON_DRIFT", `已存在终态 ${current.terminal_reason}`);
      }
      const next: OwnedLedger = {
        ...current,
        terminal: true,
        terminal_reason: reason,
        revision: current.revision + 1,
        updated_at_utc: new Date(now()).toISOString(),
      };
      journal.assertOwner(tokenHash);
      const baseBytes = readFileSync(ledgerPath);
      const intentBytes = canonical(next);
      // 注册完整操作：base/target 摘要 + owner 身份；恢复时必须逐项核验。
      journal.setPending({
        schema: "kiwi.cloud.owned-pending/1",
        operation_id: `terminal-${reason}-${next.revision}`,
        kind: "terminal",
        generation,
        token_hash: tokenHash,
        base_sha256: sha256(baseBytes),
        target_sha256: sha256(intentBytes),
        target_json: intentBytes.toString("utf8"),
      });
      crashHook("after-intent-commit");
      atomicWrite(ledgerPath, intentBytes);
      crashHook("after-ledger-replace");
      // 读回确认后才做最终 SQL 确认（清 pending + 记录摘要）。
      const readBack = readFileSync(ledgerPath);
      if (!readBack.equals(intentBytes)) fail("OWNED_LEDGER_READBACK_MISMATCH", "终态账本读回不一致");
      journal.finalize(sha256(readBack));
      crashHook("after-finalize");
      return next;
    };

    const reserve = (kind: keyof OwnedLedger["counts"]): void => {
      if (closing || !forwarding) fail("OWNED_RUNTIME_STOPPING", "运行期正在关闭");
      if (now() >= Date.parse(policy.window_end_utc)) {
        terminal("RUNTIME_WINDOW_ENDED");
        fail("OWNED_RUNTIME_WINDOW_EXPIRED", "窗口已到期");
      }
      const current = readJsonFile(ledgerPath) as OwnedLedger;
      assertLedgerSemantic(current, policy, now());
      if (current.counts[kind] >= current.caps[kind]) {
        const reason: OwnedTerminalReason =
          kind === "business_requests"
            ? "BUSINESS_REQUESTS_EXHAUSTED"
            : kind === "mcp_calls"
              ? "MCP_CALLS_EXHAUSTED"
              : "CORE_STARTS_EXHAUSTED";
        try {
          terminal(reason);
        } catch {
          /* 已终态：保留既有理由，不覆盖 */
        }
        fail(`OWNED_${reason}`, `${kind} 已达上限 ${current.caps[kind]}`);
      }
      persist((ledgerNow) => ({ ...ledgerNow, counts: { ...ledgerNow.counts, [kind]: ledgerNow.counts[kind] + 1 } }));
    };

    // Core 预留必须发生在 bootstrap（Core/listener）之前。
    reserve("core_starts");
    const value = await options.bootstrap();

    const readLedger = (): OwnedLedger => readJsonFile(ledgerPath) as OwnedLedger;
    const status = (): OwnedStatus => {
      const current = readLedger();
      return {
        policy_id: current.policy_id,
        window_id: current.window_id,
        window_start_utc: current.window_start_utc,
        window_end_utc: current.window_end_utc,
        counts: { ...current.counts },
        caps: { ...current.caps },
        process_boots: current.process_boots,
        terminal: current.terminal,
        terminal_reason: current.terminal_reason,
      };
    };

    const closeInternal = async (reason?: OwnedTerminalReason): Promise<{ result: OwnedCloseResult; ledger?: OwnedLedger }> => {
      if (confirmedStop !== undefined) return { result: { status: "CLOSED", terminal: true } };
      if (stopping) return { result: { status: "HOLD", code: "OWNED_RUNTIME_STOPPING" } };
      if (closing) return { result: { status: "CLOSED", terminal: readLedger().terminal } };
      closing = true;
      forwarding = false;
      try {
        let ledgerAfter: OwnedLedger | undefined;
        if (reason !== undefined) ledgerAfter = terminal(reason);
        if (options.closeInstance) await options.closeInstance(value);
        releaseOwner();
        return { result: { status: "CLOSED", terminal: ledgerAfter?.terminal ?? readLedger().terminal }, ledger: ledgerAfter };
      } catch (error) {
        // 关闭失败：保持非转发，暴露 UNKNOWN/HOLD，不宣称成功。
        return { result: { status: "HOLD", code: (error as OwnedRuntimeError).code ?? "OWNED_CLOSE_UNKNOWN" } };
      }
    };

    let stopping = false;
    let stopInFlight: Promise<OwnedStopResult> | undefined;
    let confirmedStop: OwnedStopResult | undefined;
    const handle: OwnedRuntimeHandle<T> = {
      value,
      status,
      isClosing: () => closing,
      forwardingEnabled: () => forwarding,
      reserveBusiness: () => reserve("business_requests"),
      reserveMcp: () => reserve("mcp_calls"),
      reserveCore: () => reserve("core_starts"),
      async close() {
        const { result } = await closeInternal();
        return result;
      },
      stopPermanently(): Promise<OwnedStopResult> {
        if (confirmedStop !== undefined) return Promise.resolve(confirmedStop);
        if (stopInFlight !== undefined) return stopInFlight;
        if (closing || stopping) return Promise.resolve({ status: "HOLD", code: "OWNED_RUNTIME_STOPPING" });
        stopping = true;
        stopInFlight = (async (): Promise<OwnedStopResult> => {
        // 1) 停新请求 2) 校验未决状态 3) 单次时钟样本（到期优先）
        forwarding = false;
        try {
          clock.read();
        } catch (error) {
          return { status: "HOLD", code: (error as { code?: string }).code ?? "OWNED_CLOCK_IDENTITY_UNKNOWN" };
        }
        const state = journal.state();
        if (state?.pending_json !== null && state?.pending_json !== undefined) {
          return { status: "HOLD", code: "OWNED_RUNTIME_STATE_UNKNOWN" };
        }
        if (state?.dispatch_json !== null && state?.dispatch_json !== undefined) {
          return { status: "HOLD", code: "OWNED_RUNTIME_STATE_UNKNOWN" };
        }
        const atMs = now();
        const expired = atMs >= Date.parse(policy.window_end_utc);
        const requestedReason: OwnedTerminalReason = expired ? "RUNTIME_WINDOW_ENDED" : "OWNER_STOPPED_PERMANENTLY";
        let ledgerAfter: OwnedLedger;
        const existing = readJsonFile(layout.ledger) as OwnedLedger;
        let reason: OwnedTerminalReason = requestedReason;
        if (existing.terminal) {
          try { assertLedgerSemantic(existing, policy, atMs); }
          catch (error) { return { status: "HOLD", code: (error as { code?: string }).code ?? "OWNED_RUNTIME_STATE_UNKNOWN" }; }
          // 自然终态已经是权威结果：stop 只读回并复用实际 reason，不重写账本。
          reason = existing.terminal_reason as OwnedTerminalReason;
          ledgerAfter = existing;
        } else {
          try {
            ledgerAfter = terminal(requestedReason);
          } catch (error) {
            return { status: "HOLD", code: (error as OwnedRuntimeError).code ?? "OWNED_STOP_UNKNOWN" };
          }
        }
        // 读回校验：账本字节、理由、revision、计数、journal ledger sha 必须一致。
        const bytes = readFileSync(layout.ledger);
        const readBack = readJsonFile(layout.ledger) as OwnedLedger;
        const journalState = journal.state();
        const consistent =
          canonical(readBack).equals(bytes) &&
          readBack.terminal === true &&
          readBack.terminal_reason === reason &&
          readBack.revision === ledgerAfter.revision &&
          journalState?.pending_json === null &&
          journalState?.last_ledger_sha256 === sha256(bytes);
        if (!consistent) return { status: "HOLD", code: "OWNED_TERMINAL_READBACK_MISMATCH" };
        // 终态已持久且读回一致；资源释放失败也不能 reject 或谎称仍转发。
        if (options.closeInstance) {
          try {
            await options.closeInstance(value);
          } catch (error) {
            releaseOwner();
            return {
              status: "HOLD",
              code: (error as OwnedRuntimeError).code ?? "OWNED_CLOSE_FAILED",
              reason,
              revision: readBack.revision,
              ledger_sha256: sha256(bytes),
            };
          }
        }
        releaseOwner();
        return { status: "TERMINAL_CONFIRMED", reason, revision: readBack.revision, ledger_sha256: sha256(bytes) };
        })().then((result) => {
          if (result.status === "TERMINAL_CONFIRMED") confirmedStop = result;
          return result;
        }, (error) => ({ status: "HOLD", code: (error as { code?: string }).code ?? "OWNED_STOP_UNKNOWN" }));
        return stopInFlight;
      },
    };
    return handle;
  } catch (error) {
    releaseOwner();
    throw error;
  }
}
