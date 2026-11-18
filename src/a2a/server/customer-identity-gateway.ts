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
 * 验签买家的本店身份建档通道（买家识别与交易回执 · K1）。
 *
 * 单写者部署下管理写者由 standalone workbench 持有所有权（instance_ownership
 * CAS 租约），A2A 进程对 state.sqlite 只读。本模块把“验签上下文交给持有写权
 * 的进程”的内部命令通道做成可插拔 Writer：
 *
 * - `local`（缺省）：A2A 进程自身即写者（单进程部署/测试），直接幂等建档。
 * - `spooled`：建档意图先落本地 spool（a2a dir JSON，进程崩溃不丢），再转发
 *   给写者进程的内部端点；写者短时不可用时**绝不阻塞普通询价**、绝不承诺
 *   已建档，spool 保留并在后续请求与定时 drain 中可靠重试（A6）。
 *
 * 转发端点契约：POST {forwardUrl}，头 `x-kiwi-identity-channel-token`，
 * 体 `{merchant_id, verified_actor, source, negotiation_id?, message_id?}`，
 * 成功 `{ok:true, subject_id}`；任何网络/5xx/鉴权失败都视为写者不可用。
 * 建档语义（幂等、唯一映射、REVOKED 不重建）由写者侧
 * `ensureVerifiedCustomerIdentity` 保证——通道重试不会产生重复主体。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { resolveOpenInquirySessionKey } from "../open-inquiry-session.js";
import { QuoteHistoryStore, validateDelegationShape } from "../../merchant-core/customer-memory/quote-history.js";
import type { QuoteHistoryAccess } from "./merchant-handler.js";

import {
  ensureVerifiedCustomerIdentity,
} from "../../merchant-core/customer-memory/auto-identity.js";
import { CustomerMemoryError } from "../../merchant-core/customer-memory/types.js";
import { inImmediateTransaction } from "../../merchant-core/storage/transaction.js";
import { registerGovernanceLedgers } from "../../merchant-core/migrations/ledgers.js";

function assertLocalWriter(db: DatabaseSync, merchantId: string, now: string, assertOwner?: () => void): void {
  if (assertOwner !== undefined) {
    assertOwner();
    return;
  }
  const ownershipTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'instance_ownership'").get();
  if (ownershipTable === undefined) return;
  const holder = db.prepare(
    "SELECT 1 FROM instance_ownership WHERE merchant_id = ? AND state = 'HELD' AND lease_expires_at > ?",
  ).get(merchantId, now);
  if (holder !== undefined) throw new Error("Workbench holds the customer writer lease");
}

/** 建档请求：verified_actor 必须是服务端验签所得身份（不是正文自报）。 */
export interface IdentityRegistrationRequest {
  merchant_id: string;
  verified_actor: string;
  source: "rfq" | "inquiry" | "reception-text";
  negotiation_id?: string;
  message_id?: string;
}

export type IdentityRegistrationOutcome =
  | { status: "registered"; subject_id: string; created: boolean }
  /** 写者不可用：普通询价继续，历史暂不可用；意图已入 spool 可靠重试。 */
  | { status: "unavailable"; reason: string };

/** 本店身份建档 Writer 接缝。实现必须幂等。 */
export interface CustomerIdentityWriter {
  ensure(input: IdentityRegistrationRequest): Promise<IdentityRegistrationOutcome>;
  drain?(): Promise<void>;
  close?(): void;
}

// ---------------------------------------------------------------------------
// 本地 Writer：A2A 进程即写者（直接写 state.sqlite）
// ---------------------------------------------------------------------------

export class LocalCustomerIdentityWriter implements CustomerIdentityWriter {
  private readonly dbPath: string;
  private readonly now: () => string;
  private handle: DatabaseSync | undefined;
  private readonly assertOwner?: () => void;
  private readonly spool?: IdentitySpool;

  constructor(options: { dbPath: string; now: () => string; assertOwner?: () => void; spoolFile?: string }) {
    this.dbPath = options.dbPath;
    this.assertOwner = options.assertOwner;
    this.now = options.now;
    if (options.spoolFile !== undefined) this.spool = new IdentitySpool(options.spoolFile, options.now);
  }

  async ensure(input: IdentityRegistrationRequest): Promise<IdentityRegistrationOutcome> {
    const result = this.write(input);
    if (result.status === "registered") this.spool?.remove(input.merchant_id, input.verified_actor);
    else this.spool?.upsert(input, result.reason);
    return result;
  }

  async drain(): Promise<void> {
    for (const entry of this.spool?.due() ?? []) await this.ensure(entry);
  }

  private write(input: IdentityRegistrationRequest): IdentityRegistrationOutcome {
    const db = this.open();
    if (db === undefined) {
      return { status: "unavailable", reason: "customer identity store unavailable" };
    }
    try {
      const result = inImmediateTransaction(db, () => {
        const stamp = this.now();
        assertLocalWriter(db, input.merchant_id, stamp, this.assertOwner);
        return ensureVerifiedCustomerIdentity(db, {
          merchant_id: input.merchant_id,
          verified_actor: input.verified_actor,
          now: stamp,
        });
      });
      return { status: "registered", subject_id: result.subject_id, created: result.created };
    } catch (err) {
      // 存储损坏/迁移缺口等：建档不可用，但不阻断询价。
      return {
        status: "unavailable",
        reason: err instanceof CustomerMemoryError ? `identity store error: ${err.reason}` : "identity store error",
      };
    }
  }

  close(): void {
    this.handle?.close();
    this.handle = undefined;
  }

  private open(): DatabaseSync | undefined {
    if (this.handle !== undefined) return this.handle;
    try {
      // 惰性打开 + 触发模块迁移（幂等；老库补 v4 表）。
      this.assertOwner?.();
      const db = new DatabaseSync(this.dbPath);
      try {
        db.exec("PRAGMA busy_timeout = 3000");
        registerGovernanceLedgers(db);
      } catch (error) {
        db.close();
        throw error;
      }
      this.handle = db;
      return db;
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Spool（持久待发队列；进程崩溃后重试仍指向同一建档意图）
// ---------------------------------------------------------------------------

interface IdentitySpoolEntry {
  merchant_id: string;
  verified_actor: string;
  source: IdentityRegistrationRequest["source"];
  negotiation_id?: string;
  message_id?: string;
  first_seen_at: string;
  attempts: number;
  last_error?: string;
}

interface IdentitySpoolFile {
  version: 1;
  pending: IdentitySpoolEntry[];
}

const SPOOL_MAX_ENTRIES = 10_000;
const SPOOL_RETRY_MIN_INTERVAL_MS = 30_000;

class IdentitySpool {
  private state: IdentitySpoolFile;

  constructor(private readonly file: string, private readonly now: () => string) {
    this.state = this.load();
  }

  upsert(input: IdentityRegistrationRequest, error?: string): void {
    const existing = this.state.pending.find(
      (entry) => entry.merchant_id === input.merchant_id && entry.verified_actor === input.verified_actor,
    );
    if (existing !== undefined) {
      existing.attempts += 1;
      if (error !== undefined) existing.last_error = error;
      this.save();
      return;
    }
    if (this.state.pending.length >= SPOOL_MAX_ENTRIES) {
      // 有界保护：溢出时丢弃最老的待发项（最老者最可能已被后续请求覆盖）。
      this.state.pending.shift();
    }
    this.state.pending.push({
      merchant_id: input.merchant_id,
      verified_actor: input.verified_actor,
      source: input.source,
      ...(input.negotiation_id !== undefined ? { negotiation_id: input.negotiation_id } : {}),
      ...(input.message_id !== undefined ? { message_id: input.message_id } : {}),
      first_seen_at: this.now(),
      attempts: 1,
      ...(error !== undefined ? { last_error: error } : {}),
    });
    this.save();
  }

  remove(merchantId: string, verifiedActor: string): void {
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter(
      (entry) => !(entry.merchant_id === merchantId && entry.verified_actor === verifiedActor),
    );
    if (this.state.pending.length !== before) this.save();
  }

  /** 到期可重试的待发项（attempts 指数退避由调度方控制，这里只做最小间隔）。 */
  due(): IdentitySpoolEntry[] {
    return this.state.pending.slice();
  }

  private load(): IdentitySpoolFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as IdentitySpoolFile;
      if (parsed.version === 1 && Array.isArray(parsed.pending)) return parsed;
    } catch {
      // 首次启动或坏文件：从空 spool 开始（意图会在下一次有效询价重建）。
    }
    return { version: 1, pending: [] };
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

// ---------------------------------------------------------------------------
// Spooled Writer：spool + 转发（内部命令通道）
// ---------------------------------------------------------------------------

export interface SpooledIdentityWriterOptions {
  /** spool 文件绝对路径（a2a dir 内）。 */
  spoolFile: string;
  /** 写者进程内部端点；未配置时所有意图保持 pending（历史暂不可用）。 */
  forwardUrl?: string;
  /** 内部通道共享凭据（`x-kiwi-identity-channel-token`）。 */
  forwardToken?: string;
  now: () => string;
  fetchImpl?: typeof fetch;
  logError?: (message: string, err: unknown) => void;
}

export class SpooledCustomerIdentityWriter implements CustomerIdentityWriter {
  private readonly spool: IdentitySpool;
  private readonly forwardUrl: string | undefined;
  private readonly forwardToken: string | undefined;
  private readonly now: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly logError: (message: string, err: unknown) => void;
  private lastAttemptAt = 0;

  constructor(options: SpooledIdentityWriterOptions) {
    this.spool = new IdentitySpool(options.spoolFile, options.now);
    this.forwardUrl = options.forwardUrl;
    this.forwardToken = options.forwardToken;
    this.now = options.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logError = options.logError ?? (() => {});
  }

  async ensure(input: IdentityRegistrationRequest): Promise<IdentityRegistrationOutcome> {
    if (this.forwardUrl === undefined) {
      this.spool.upsert(input, "forward endpoint not configured");
      return { status: "unavailable", reason: "identity writer endpoint not configured" };
    }
    this.spool.upsert(input);
    const outcome = await this.forward(input);
    if (outcome.status === "registered") {
      this.spool.remove(input.merchant_id, input.verified_actor);
      // 顺手清掉同 actor 的历史待发项（remove 已按 merchant+actor 精确匹配）。
      return outcome;
    }
    this.spool.upsert(input, outcome.reason);
    return outcome;
  }

  /** drain：spool 中的历史意图可靠重试（启动时/定时调用）。 */
  async drain(): Promise<void> {
    if (this.forwardUrl === undefined) return;
    const nowMs = Date.parse(this.now());
    if (Number.isFinite(nowMs) && nowMs - this.lastAttemptAt < SPOOL_RETRY_MIN_INTERVAL_MS) return;
    this.lastAttemptAt = nowMs;
    for (const entry of this.spool.due()) {
      const outcome = await this.forward({
        merchant_id: entry.merchant_id,
        verified_actor: entry.verified_actor,
        source: entry.source,
        ...(entry.negotiation_id !== undefined ? { negotiation_id: entry.negotiation_id } : {}),
        ...(entry.message_id !== undefined ? { message_id: entry.message_id } : {}),
      });
      if (outcome.status === "registered") {
        this.spool.remove(entry.merchant_id, entry.verified_actor);
      } else {
        this.spool.upsert(
          {
            merchant_id: entry.merchant_id,
            verified_actor: entry.verified_actor,
            source: entry.source,
          },
          outcome.reason,
        );
      }
    }
  }

  private async forward(input: IdentityRegistrationRequest): Promise<IdentityRegistrationOutcome> {
    try {
      const response = await this.fetchImpl(this.forwardUrl as string, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(this.forwardToken !== undefined
            ? { "x-kiwi-identity-channel-token": this.forwardToken }
            : {}),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return { status: "unavailable", reason: `identity writer http ${response.status}` };
      }
      const body = (await response.json()) as { ok?: boolean; subject_id?: string; created?: boolean };
      if (body.ok === true && typeof body.subject_id === "string") {
        return {
          status: "registered",
          subject_id: body.subject_id,
          created: body.created === true,
        };
      }
      return { status: "unavailable", reason: "identity writer returned invalid response" };
    } catch (err) {
      this.logError("customer identity forward failed", err);
      return { status: "unavailable", reason: "identity writer unreachable" };
    }
  }
}

/** 从环境装配 Writer（缺省 local）。 */
export function resolveCustomerIdentityWriter(
  options: {
    dataDir: string;
    a2aDir: string;
    now: () => string;
    logError?: (message: string, err: unknown) => void;
    assertOwner?: () => void;
  },
): CustomerIdentityWriter {
  const mode = process.env.KIWI_CUSTOMER_IDENTITY_WRITER ?? "local";
  if (mode === "spooled") {
    return new SpooledCustomerIdentityWriter({
      spoolFile: `${options.a2aDir}/identity-registration-spool.json`,
      ...(process.env.KIWI_CUSTOMER_IDENTITY_FORWARD_URL !== undefined
        ? { forwardUrl: process.env.KIWI_CUSTOMER_IDENTITY_FORWARD_URL }
        : {}),
      ...(process.env.KIWI_CUSTOMER_IDENTITY_CHANNEL_TOKEN !== undefined
        ? { forwardToken: process.env.KIWI_CUSTOMER_IDENTITY_CHANNEL_TOKEN }
        : {}),
      now: options.now,
      ...(options.logError !== undefined ? { logError: options.logError } : {}),
    });
  }
  return new LocalCustomerIdentityWriter({
    dbPath: `${options.dataDir}/state.sqlite`,
    spoolFile: `${options.a2aDir}/identity-registration-spool.json`,
    now: options.now,
    assertOwner: options.assertOwner,
  });
}

type DelegationWrite = Parameters<QuoteHistoryStore["applyDelegation"]>[0];
type OfferWrite = Parameters<QuoteHistoryStore["indexOffer"]>[0];
type HistoryWrite = { kind: "delegation"; input: DelegationWrite } | { kind: "offer"; input: OfferWrite };

export function createQuoteHistoryAccess(options: {
  dbPath: string;
  now: () => string;
  assertOwner?: () => void;
}): { store: QuoteHistoryAccess; close(): void } {
  const remote = process.env.KIWI_CUSTOMER_IDENTITY_WRITER === "spooled";
  let db: DatabaseSync | undefined;
  const open = (): QuoteHistoryStore | undefined => {
    try {
      db ??= new DatabaseSync(options.dbPath, { readOnly: true });
      return new QuoteHistoryStore({ db, now: options.now });
    } catch {
      return undefined;
    }
  };
  let writeDb: DatabaseSync | undefined;
  const write = async (command: HistoryWrite): Promise<void> => {
    if (remote) {
      const url = process.env.KIWI_CUSTOMER_IDENTITY_FORWARD_URL;
      const token = process.env.KIWI_CUSTOMER_IDENTITY_CHANNEL_TOKEN;
      if (url === undefined || token === undefined) return;
      const response = await fetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
        headers: { "content-type": "application/json", "x-kiwi-identity-channel-token": token },
        body: JSON.stringify(command),
      });
      if (!response.ok) throw new Error("Workbench history write unavailable");
      await response.body?.cancel();
      return;
    }
    if (writeDb === undefined) {
      writeDb = new DatabaseSync(options.dbPath);
      writeDb.exec("PRAGMA busy_timeout = 3000");
    }
    const connection = writeDb;
    inImmediateTransaction(connection, () => {
      assertLocalWriter(connection, command.input.merchant_id, options.now(), options.assertOwner);
      const store = new QuoteHistoryStore({ db: connection, now: options.now });
      if (command.kind === "delegation") store.applyDelegation(command.input);
      else store.indexOffer(command.input);
    });
  };
  return {
    store: {
      checkActive: (input) => open()?.checkActive(input),
      queryHistory: (input) => open()?.queryHistory(input) ?? [],
      applyDelegation: (input) => write({ kind: "delegation", input }),
      indexOffer: (input) => write({ kind: "offer", input }),
    },
    close: () => { db?.close(); writeDb?.close(); },
  };
}

/** Only the bound A2A process may ask the Workbench to register its verified actor. */
export function createCustomerIdentityReceiver(options: {
  db: DatabaseSync;
  merchantId: string;
  now: () => string;
  assertOwner?: () => void;
}): (token: unknown, readBody: () => Promise<unknown>) => Promise<{ status: number; body: Record<string, unknown> }> {
  const tokenHash = (value: string): Buffer => createHash("sha256").update(value).digest();
  return async (token, readBody) => {
    const expected = process.env.KIWI_CUSTOMER_IDENTITY_CHANNEL_TOKEN;
    if (options.assertOwner === undefined || typeof token !== "string" || expected === undefined ||
        expected.length < 32 || !timingSafeEqual(tokenHash(token), tokenHash(expected))) {
      return { status: 404, body: { ok: false } };
    }
    const body = await readBody();
    if (body === null || typeof body !== "object") return { status: 400, body: { ok: false } };
    const command = body as Partial<HistoryWrite>;
    try {
      return inImmediateTransaction(options.db, () => {
        options.assertOwner?.();
        const store = new QuoteHistoryStore({ db: options.db, now: options.now });
        if (command.kind === "delegation" || command.kind === "offer") {
          const input = command.input;
          if (input?.merchant_id !== options.merchantId) return { status: 400, body: { ok: false } };
          if (command.kind === "delegation") {
            const delegation = command.input as DelegationWrite;
            if (resolveOpenInquirySessionKey(delegation.buyer_actor) === undefined ||
                !validateDelegationShape(delegation.delegation, options.merchantId, options.now()).ok) {
              return { status: 400, body: { ok: false } };
            }
            store.applyDelegation(delegation);
          } else {
            store.indexOffer(command.input as OfferWrite);
          }
          return { status: 200, body: { ok: true } };
        }
        const input = body as Partial<IdentityRegistrationRequest>;
        if (input.merchant_id !== options.merchantId || typeof input.verified_actor !== "string" ||
            resolveOpenInquirySessionKey(input.verified_actor) === undefined ||
            !["rfq", "inquiry", "reception-text"].includes(input.source ?? "")) {
          return { status: 400, body: { ok: false } };
        }
        const result = ensureVerifiedCustomerIdentity(options.db, {
          merchant_id: options.merchantId, verified_actor: input.verified_actor, now: options.now(),
        });
        return { status: 200, body: { ok: true, subject_id: result.subject_id, created: result.created } };
      });
    } catch {
      return { status: 503, body: { ok: false } };
    }
  };
}
