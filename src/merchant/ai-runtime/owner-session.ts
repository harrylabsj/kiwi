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

/** A210 local-only owner host. Official SDK loop + explicit trusted business
 * capabilities; absent provider/facts/budget/verifier configuration fails closed.
 * Dual switch CLI default off; no public owner endpoint or default business approval.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  realpathSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { contentDigest } from "../../negotiation/jcs.js";
import {
  assertOwnerStorageAdmission,
  assertOwnerStorageReady,
  guardOwnerStorage,
  requireOwnerProvider,
  type OwnerStorageAdmission,
} from "./owner-storage-admission.js";
import { createOwnerRequestGate, guardOwnerModels } from "./owner-provider-guard.js";
import { createFileGrantResolver } from "./owner-file-grant.js";
import {
  executeApprovedCandidate,
  WriteApprovalCandidateStore,
} from "../../agent/merchant/action-candidate.js";

// ── 双开关（缺省 off）───────────────────────────────────────────────────────

export interface OwnerSessionSwitches {
  ownerEnabled: boolean;
  aiRuntimeEnabled: boolean;
}

export function readOwnerSessionSwitches(
  env: Record<string, string | undefined>,
): OwnerSessionSwitches {
  const on = (v: string | undefined) => v === "true" || v === "1";
  return {
    ownerEnabled: on(env.KIWI_OWNER_SESSION_ENABLED),
    aiRuntimeEnabled: on(env.KIWI_AI_RUNTIME_ENABLED),
  };
}

export function ownerSessionFullyEnabled(s: OwnerSessionSwitches): boolean {
  return s.ownerEnabled && s.aiRuntimeEnabled;
}

// ── 身份/目录派生（opaque 精确比较 + sha256 独立派生）────────────────────────

export function assertOpaqueMerchantId(merchantId: unknown): string {
  if (typeof merchantId !== "string" || merchantId.length === 0 || merchantId.length > 256) {
    throw new OwnerSessionError("invalid_merchant_id", "merchantId 必须是非空字符串（≤256）");
  }
  return merchantId;
}

export function merchantDirName(merchantId: string): string {
  return createHash("sha256").update(merchantId, "utf8").digest("hex");
}

export function merchantStorageDir(storageRoot: string, merchantId: string): string {
  assertOpaqueMerchantId(merchantId);
  const base = resolve(storageRoot, "merchants");
  const dir = resolve(base, merchantDirName(merchantId));
  if (!dir.startsWith(base + sep))
    throw new OwnerSessionError("storage_path_escape", "存储路径越界");
  return dir;
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if ((statSync(dir).mode & 0o777) !== 0o700) {
    throw new OwnerSessionError("data_dir_permission", `目录权限必须 0700：${dir}`);
  }
}

function writePrivateJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file); // 原子 rename 只防半写
  chmodSync(file, 0o600);
}

function readPrivateJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined; // 坏文件按缺失处理（unknown 语义，不猜）
  }
}

// ── R1 file grant（每次强读）────────────────────────────────────────────────

export interface FileGrant {
  merchantId: string;
  principal: string;
  granted_at: string;
}

export type GrantCheck =
  | { ok: true; grant: FileGrant }
  | { ok: false; code: "grant_missing" | "grant_unknown" | "grant_merchant_mismatch" };

export function checkFileGrant(
  grantFile: string,
  merchantId: string,
  principal: string,
): GrantCheck {
  assertOpaqueMerchantId(merchantId);
  let raw: string;
  try {
    raw = readFileSync(grantFile, "utf8");
  } catch {
    return { ok: false, code: "grant_unknown" };
  }
  let grant: FileGrant;
  try {
    grant = JSON.parse(raw) as FileGrant;
  } catch {
    return { ok: false, code: "grant_unknown" };
  }
  if (typeof grant !== "object" || grant === null || typeof grant.merchantId !== "string") {
    return { ok: false, code: "grant_unknown" };
  }
  if (grant.merchantId !== merchantId) return { ok: false, code: "grant_merchant_mismatch" };
  if (typeof grant.principal !== "string" || grant.principal !== principal) {
    return { ok: false, code: "grant_merchant_mismatch" };
  }
  return { ok: true, grant };
}

// ── operation 状态机（业务 key 绑定，C3）────────────────────────────────────

export type OperationState = "reserved" | "pending" | "settled" | "reconciliation";

export interface OperationRecord {
  operation_id: string;
  merchant_id: string;
  principal_id?: string;
  candidate_id?: string;
  /** 业务 key：kind + argsHash（同业务重复驱动在此阻断）。 */
  business_key: string;
  kind: string;
  args_hash: string;
  state: OperationState;
  created_at: string;
  updated_at: string;
  reconciliation?: {
    decided_at: string;
    outcome: "settled_no_new_effect" | "settled_with_evidence" | "requires_manual_review";
    evidence?: string;
  };
}

export class OwnerSessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A204-D5：受信本地核对器——reconciliation 结算必须经它核对（绑定 source/
 * operation/merchant 的真实核查结果）；任意字符串自述不构成权威对账。
 */
export interface ReconciliationVerifier {
  /** Legacy boolean attestations are ignored by A210. */
  verify?(input: {
    operationId: string;
    merchantId: string;
    businessKey: string;
    evidence: string;
  }): { trusted: true } | { trusted: false; reason: string };
  source?: string;
  query?(input: {
    operationId: string;
    merchantId: string;
    principal: string;
    businessKey: string;
  }): {
    source: string;
    operationId: string;
    merchantId: string;
    principal: string;
    businessKey: string;
    receiptRef: string;
    outcome: "confirmed_applied" | "confirmed_not_applied" | "unknown";
  };
}

interface OperationsFile {
  operations: Record<string, OperationRecord>;
}

/**
 * 业务 key：kind + argsHash（参数内容绑定，非调用次数）。
 * A202-R3：argsHash 复用冻结的 contentDigest（JCS canonical，嵌套全层级
 * 可见）——不再自造 JSON replacer（旧实现根层键白名单致嵌套同名键变化不可见）。
 */
export function businessKey(kind: string, args: unknown): string {
  return `${kind}:${contentDigest(args).slice(7, 39)}`; // sha256: 后取 32 hex
}

// ── 单 writer 准入锁（C2）───────────────────────────────────────────────────

interface AdmissionFile {
  pid: number;
  started_at: string;
  merchant_id: string;
  module: "a199-local-owner-session";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0 = 存活探测
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code === "EPERM"; // EPERM=存在但无权
  }
}

/**
 * C2：单 writer 准入——admission.lock 用 O_EXCL 原子创建；已存在且持有进程
 * 仍存活 ⇒ 拒（admission_writer_active）；持锁进程已死 ⇒ 崩溃残留，接管重写。
 */
interface AdmissionLockFile extends AdmissionFile {
  /** A202-R2：实例唯一 ownership token——release 只删自己 token 的锁。 */
  ownership_token: string;
}

function acquireAdmissionLock(dir: string, merchantId: string): string {
  const lockPath = join(dir, "admission.lock");
  const ownershipToken = createHash("sha256")
    .update(`${merchantId}:${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex");
  const write = (): void => {
    const fd = openSync(lockPath, "wx", 0o600); // O_EXCL 原子
    try {
      writeFileSync(
        fd,
        JSON.stringify(
          {
            pid: process.pid,
            started_at: new Date().toISOString(),
            merchant_id: merchantId,
            module: "a199-local-owner-session",
            ownership_token: ownershipToken,
          } satisfies AdmissionLockFile,
          null,
          2,
        ),
      );
    } finally {
      closeSync(fd);
    }
    chmodSync(lockPath, 0o600);
  };
  try {
    write();
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") {
      throw new OwnerSessionError("admission_lock_failed", `准入锁创建失败：${String(err)}`);
    }
    const existing = readPrivateJson<AdmissionLockFile>(lockPath);
    if (
      existing === undefined ||
      !Number.isSafeInteger(existing.pid) ||
      existing.pid < 1 ||
      typeof existing.ownership_token !== "string"
    )
      throw new OwnerSessionError("admission_unknown", "unreadable admission lock");
    if (isProcessAlive(existing.pid)) {
      // 同进程重复 open / 另一进程并存：都是单 writer 违规（A178 返修 C2）。
      const who =
        existing.pid === process.pid ? "本进程已有实例" : `另一 writer（pid ${existing.pid}）`;
      throw new OwnerSessionError(
        "admission_writer_active",
        `${who}已持有该数据目录准入锁——单 writer 语义拒绝`,
      );
    }
    // A202-R2：崩溃残留接管前 fail-closed 再核——O_EXCL 若被并发接管方先建
    //（EEXIST）则视为新的活跃锁拒绝（不覆盖、不猜测）。
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
    try {
      write();
    } catch (err2) {
      if ((err2 as { code?: string }).code === "EEXIST") {
        throw new OwnerSessionError(
          "admission_writer_active",
          "接管竞态：准入锁已被并发方重建——单 writer 语义拒绝",
        );
      }
      throw new OwnerSessionError("admission_lock_failed", `准入锁接管失败：${String(err2)}`);
    }
  }
  return ownershipToken;
}

/** A202-R2：release 仅当锁内 ownership_token == 自身 token 才删（幂等；旧实例不能删新锁）。 */
function releaseAdmissionLock(dir: string, ownershipToken: string): void {
  const lockPath = join(dir, "admission.lock");
  const existing = readPrivateJson<AdmissionLockFile>(lockPath);
  if (existing === undefined) return; // 幂等：锁已不在
  if (existing.ownership_token !== ownershipToken) return; // 新持有者的锁——不得删
  rmSync(lockPath, { force: true });
}

// ── owner 会话 v2 ───────────────────────────────────────────────────────────

// A210: trusted local assembly. No default provider, business executor or facts.
export interface OwnerBudgetGate {
  acquire(input: {
    merchantId: string;
    estimatedTokens: number;
  }): Promise<{ allowed: true; leaseId: string } | { allowed: false; reason: string }>;
  settle(input: { leaseId: string; usedTokens: number }): Promise<void>;
}
export interface ApprovalStoreLike {
  create(input: {
    tool: string;
    arguments: Record<string, unknown>;
    preconditions: Record<string, unknown>;
    risk: string;
    expires_at: string;
  }): { candidate_id: string; status: string };
  get(candidateId: string):
    | {
        candidate_id: string;
        status: string;
        tool?: string;
        arguments?: unknown;
        preconditions?: unknown;
        merchant_id?: unknown;
      }
    | undefined;
  markApproved(candidateId: string): unknown;
  expireCandidate(candidateId: string): unknown;
  listPending(): ReadonlyArray<{ candidate_id: string; status: string; tool?: string }>;
  ownerBinding?: Readonly<{ merchantId: string; principal: string }>;
  expireForRecovery?(): number;
  expireDue?(): number;
  claimForExecution?(id: string): unknown;
  markExecuted?(id: string): unknown;
  supersede?(id: string): unknown;
}
export interface OwnerBusinessTool extends importToolSpec {
  readFresh(args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>>;
  execute(
    args: Record<string, unknown>,
    operationId: string,
  ): Promise<{ known: boolean; result: import("@earendil-works/pi-durable").ToolExecutionResult }>;
}
type importToolSpec = import("./owner-sdk-tools.js").OwnerSdkToolSpec;
export interface OwnerSdkRuntime {
  models: import("@earendil-works/pi-ai/models").Models;
  model: import("@earendil-works/pi-durable").ModelRef;
  reservationTokens: number;
  maxRequests: number;
  timeoutMs: number;
  tools: readonly OwnerBusinessTool[];
}
export interface SdkSurface {
  sessionFile: string;
  history(limit?: number): Promise<string[]>;
  /** Legacy compatibility only; never used by the A210 official runtime. */
  hostGate(args: { text: string }): void;
  host?: import("./owner-sdk-tools.js").OwnerSdkHost;
  mode?: "converse" | "operation";
  runtime?: OwnerSdkRuntime;
  checkGrant?: () => void;
  storageAdmission?: OwnerStorageAdmission;
}
export type EffectRunner = (input: {
  operationId: string;
  businessKey: string;
  text: string;
  sdk: SdkSurface;
  registerOwnerTools?: boolean;
}) => Promise<EffectOutcome>;
export interface EffectOutcome {
  known: boolean;
  summary: string;
  usedTokens?: number;
}
export interface OwnerSessionInput {
  storageAdmission?: OwnerStorageAdmission;
  /** Explicit trusted in-process enablement; absent uses dual default-off env. */
  switches?: OwnerSessionSwitches;
  storageRoot: string;
  merchantId: string;
  grantFile: string;
  principal: string;
  now?: () => string;
  reconciliationVerifier?: ReconciliationVerifier;
  budgetGate?: OwnerBudgetGate;
  approvals?: ApprovalStoreLike;
  sdkRuntime?: OwnerSdkRuntime;
  /** Legacy runners are not accepted for gated business execution. */
  effectRunner?: EffectRunner;
}
export interface OwnerSubmitResult {
  ok: true;
  operationId: string;
  state: "settled";
  turnSummary: string;
}
export interface OwnerSubmitReconciliation {
  ok: false;
  operationId: string;
  state: "reconciliation";
  reason: "unknown_result_no_redrive";
}
export type OwnerSubmitOutcome =
  OwnerSubmitResult | OwnerSubmitReconciliation | { ok: false; code: string; message: string };
type SubmitInput = {
  text: string;
  mode?: "converse" | "operation";
  kind?: string;
  args?: Record<string, unknown>;
  approval?: { candidateId: string; approvedBy?: string; approvalRef?: string };
};

export class LocalMerchantOwnerSession {
  readonly sessionFile: string;
  readonly recoveredApprovalCount: number = 0;
  private readonly operationsFile: string;
  private readonly dataDir: string;
  private readonly ownershipToken: string;
  private readonly nowFn: () => string;
  private readonly input: OwnerSessionInput;
  private readonly grant: import("./owner-file-grant.js").FileGrantResolver;
  private queue: Promise<unknown> = Promise.resolve();
  private released = false;
  private activeTurn = false;
  private journalInitialized = false;
  constructor(input: OwnerSessionInput) {
    if (!ownerSessionFullyEnabled(input.switches ?? readOwnerSessionSwitches(process.env)))
      throw new OwnerSessionError(
        "owner_session_disabled",
        "both owner switches must be explicitly enabled",
      );
    this.input = {
      ...input,
      sdkRuntime:
        input.sdkRuntime === undefined
          ? undefined
          : { ...input.sdkRuntime, tools: input.sdkRuntime.tools.map((t) => ({ ...t })) },
    };
    assertOpaqueMerchantId(input.merchantId);
    this.grant = createFileGrantResolver({
      merchantId: input.merchantId,
      principal: input.principal,
    });
    this.assertGrant();
    assertOwnerStorageAdmission(input.storageAdmission, input);
    this.nowFn = input.now ?? (() => new Date().toISOString());
    this.dataDir = merchantStorageDir(input.storageRoot, input.merchantId);
    ensurePrivateDir(this.dataDir);
    this.ownershipToken = acquireAdmissionLock(this.dataDir, input.merchantId);
    this.operationsFile = join(this.dataDir, "operations.json");
    this.sessionFile = join(this.dataDir, "session.sqlite");
    this.journalInitialized =
      existsSync(join(this.dataDir, "admission.json")) || existsSync(this.sessionFile);
    try {
      writePrivateJson(join(this.dataDir, "admission.json"), {
        merchant_id: input.merchantId,
        opened_at: this.nowFn(),
        module: "a210-local-owner",
      });
      // Pre-create privately BEFORE SDK opens. No process-wide umask mutation.
      if (!existsSync(this.sessionFile)) closeSync(openSync(this.sessionFile, "wx", 0o600));
      chmodSync(this.sessionFile, 0o600);
      if ((statSync(this.sessionFile).mode & 0o777) !== 0o600)
        throw new OwnerSessionError("session_permission", "session must be private");
      this.recoverOperations();
      // Bound real store only; never expire an arbitrary same-principal store.
      if (input.approvals !== undefined) this.recoveredApprovalCount = this.expireForRecovery();
    } catch (error) {
      releaseAdmissionLock(this.dataDir, this.ownershipToken);
      throw error;
    }
  }
  private assertGrant(): void {
    if (this.released) throw new OwnerSessionError("session_closed", "session released");
    const g = this.grant.readStrong(this.input.grantFile);
    if (!g.ok) throw new OwnerSessionError(g.code, g.message);
  }
  private store(): import("../../agent/merchant/action-candidate.js").WriteApprovalCandidateStore {
    const s = this.input.approvals;
    if (
      !(s instanceof WriteApprovalCandidateStore) ||
      s.ownerStorageFile === undefined ||
      !realpathSync(s.ownerStorageFile).startsWith(realpathSync(this.dataDir) + sep)
    )
      throw new OwnerSessionError(
        "approval_store_missing",
        "real persistent approval store required",
      );
    if (
      s?.ownerBinding?.merchantId !== this.input.merchantId ||
      s.ownerBinding.principal !== this.input.principal
    )
      throw new OwnerSessionError(
        "approval_store_binding_missing",
        "bound owner approval store required",
      );
    if (
      typeof s.expireForRecovery !== "function" ||
      typeof s.expireDue !== "function" ||
      typeof s.claimForExecution !== "function" ||
      typeof s.markExecuted !== "function" ||
      typeof s.supersede !== "function"
    )
      throw new OwnerSessionError("approval_store_missing", "real owner approval store required");
    return s as import("../../agent/merchant/action-candidate.js").WriteApprovalCandidateStore;
  }
  get operationsPath(): string {
    return this.operationsFile;
  }
  private readOperations(): OperationsFile {
    if (!existsSync(this.operationsFile)) {
      if (this.journalInitialized)
        throw new OwnerSessionError("operations_unknown", "operation journal missing");
      return { operations: {} };
    }
    const data = readPrivateJson<OperationsFile>(this.operationsFile);
    if (
      data === undefined ||
      data.operations === null ||
      typeof data.operations !== "object" ||
      Array.isArray(data.operations)
    )
      throw new OwnerSessionError("operations_unknown", "invalid operation journal");
    for (const rec of Object.values(data.operations))
      if (
        rec === null ||
        rec.merchant_id !== this.input.merchantId ||
        typeof rec.business_key !== "string"
      )
        throw new OwnerSessionError("operations_unknown", "invalid operation binding");
    return data;
  }
  private writeOperations(ops: OperationsFile): void {
    writePrivateJson(this.operationsFile, ops);
    this.journalInitialized = true;
  }
  private recoverOperations(): void {
    const ops = this.readOperations();
    for (const rec of Object.values(ops.operations))
      if (rec.state === "reserved" || rec.state === "pending") {
        rec.state = "reconciliation";
        rec.updated_at = this.nowFn();
      }
    this.writeOperations(ops);
  }
  expireForRecovery(): number {
    if (this.activeTurn)
      throw new OwnerSessionError("session_busy", "session busy; wait turn completion");
    this.assertGrant();
    const n = this.store().expireForRecovery();
    this.recoverOperations();
    return n;
  }
  submitTurn(input: SubmitInput): Promise<OwnerSubmitOutcome> {
    // Copy inputs at the trusted local API boundary, before asynchronous queue.
    const snapshot = structuredClone(input);
    const run = async () => {
      this.activeTurn = true;
      try {
        return await this.doSubmitTurn(snapshot);
      } finally {
        this.activeTurn = false;
      }
    };
    const queued = this.queue.then(run, run);
    this.queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
  private async doSubmitTurn(input: SubmitInput): Promise<OwnerSubmitOutcome> {
    const reject = (code: string): OwnerSubmitOutcome => ({ ok: false, code, message: code });
    try {
      this.assertGrant();
    } catch (e) {
      return reject(e instanceof OwnerSessionError ? e.code : "grant_unknown");
    }
    if (this.input.budgetGate === undefined) return reject("budget_gate_missing");
    const runtime = this.input.sdkRuntime;
    if (runtime === undefined || this.input.effectRunner !== undefined)
      return reject("sdk_runtime_configuration_required");
    if (
      !Number.isSafeInteger(runtime.reservationTokens) ||
      runtime.reservationTokens < 1 ||
      !Number.isSafeInteger(runtime.maxRequests) ||
      runtime.maxRequests < 1 ||
      runtime.maxRequests > 4 ||
      !Number.isSafeInteger(runtime.timeoutMs) ||
      runtime.timeoutMs < 1 ||
      runtime.timeoutMs > 30000
    )
      return reject("sdk_runtime_configuration_invalid");
    if (
      runtime.model === undefined ||
      typeof runtime.models?.getModel !== "function" ||
      runtime.models.getModel(runtime.model.provider, runtime.model.modelId) === undefined
    )
      return reject("sdk_model_configuration_required");
    const mode = input.mode === "operation" ? "operation" : "converse";
    const kind = input.kind ?? "submit_turn";
    const args = input.args ?? { text: input.text };
    const key = businessKey(kind, args);
    let store:
      import("../../agent/merchant/action-candidate.js").WriteApprovalCandidateStore | undefined;
    let candidateId: string | undefined;
    let tool: OwnerBusinessTool | undefined;
    if (mode === "operation") {
      try {
        store = this.store();
      } catch {
        return reject("approval_store_binding_missing");
      }
      tool = runtime.tools.find((t) => t.name === kind);
      if (
        tool === undefined ||
        typeof tool.readFresh !== "function" ||
        typeof tool.execute !== "function"
      )
        return reject("business_source_configuration_required");
      candidateId = input.approval?.candidateId;
      if (!candidateId) return reject("needs_approval");
      store.expireDue();
      const candidate = store.get(candidateId);
      if (candidate?.status !== "approved") return reject("needs_approval");
      const pre = candidate.preconditions;
      if (
        candidate.tool !== kind ||
        contentDigest(candidate.arguments) !== contentDigest(args) ||
        pre.merchant_id !== this.input.merchantId ||
        pre.principal !== this.input.principal ||
        pre.business_key !== key
      )
        return reject("candidate_binding_mismatch");
    }
    const existing = Object.values(this.readOperations().operations).filter(
      (r) => r.business_key === key,
    );
    if (existing.some((r) => r.state !== "settled")) return reject("operation_reconciliation");
    if (
      mode === "operation" &&
      existing.some(
        (r) =>
          r.reconciliation?.outcome !== "settled_no_new_effect" ||
          (r as OperationRecord & { candidate_id?: string }).candidate_id === candidateId,
      )
    )
      return reject("operation_already_applied_or_new_approval_required");
    const decision = await this.input.budgetGate.acquire({
      merchantId: this.input.merchantId,
      estimatedTokens: runtime.reservationTokens,
    });
    if (!decision.allowed) return reject("budget_denied");
    // Everything after acquisition, including IO, stays inside this finally.
    let usedTokens = 0;
    let enteredSdk = false;
    let usageKnown = false;
    const operationId = `op_${createHash("sha256").update(`${this.input.merchantId}:${this.nowFn()}:${Math.random()}`).digest("hex").slice(0, 24)}`;
    let toolSucceeded = false;
    let toolRefused = false;
    let effectUnknown = false;
    try {
      const ops = this.readOperations();
      ops.operations[operationId] = {
        operation_id: operationId,
        merchant_id: this.input.merchantId,
        principal_id: this.input.principal,
        ...{
          budget_lease_id: decision.leaseId,
          budget_reservation_tokens: runtime.reservationTokens,
        },
        business_key: key,
        kind,
        args_hash: contentDigest(args),
        state: "reserved",
        created_at: this.nowFn(),
        updated_at: this.nowFn(),
        ...(candidateId === undefined ? {} : { candidate_id: candidateId }),
      };
      this.writeOperations(ops);
      const setState = (state: OperationState): void => {
        const journal = this.readOperations();
        const rec = journal.operations[operationId];
        if (rec === undefined)
          throw new OwnerSessionError("operations_unknown", "operation missing");
        rec.state = state;
        rec.updated_at = this.nowFn();
        this.writeOperations(journal);
      };
      const host: import("./owner-sdk-tools.js").OwnerSdkHost = {
        historyStrong: async (limit) => this.history(limit),
        invokeTool: async (call) => {
          this.assertGrant();
          if (
            mode !== "operation" ||
            store === undefined ||
            candidateId === undefined ||
            tool === undefined ||
            toolSucceeded ||
            effectUnknown ||
            call.tool !== kind ||
            contentDigest(call.args) !== contentDigest(args) ||
            !this.checkExecutionValid(operationId, "reserved")
          ) {
            toolRefused = true;
            return {
              isError: true,
              content: [{ type: "text", text: "candidate_binding_mismatch" }],
            };
          }
          const activeTool = tool;
          const audit = this.readOperations();
          Object.assign(audit.operations[operationId]!, {
            sdk_task_id: call.taskId,
            sdk_conversation_id: call.conversationId,
            sdk_call_id: call.callId,
          });
          this.writeOperations(audit);
          const outcome = await executeApprovedCandidate(store, candidateId, {
            readPreconditions: async () => {
              this.assertGrant();
              const facts = await activeTool.readFresh(call.args);
              if (facts === null || typeof facts !== "object" || Array.isArray(facts))
                throw new Error("business_source_unknown");
              this.assertGrant();
              // Identity/business slots are host-bound, never model/source labels.
              return {
                ...facts,
                merchant_id: this.input.merchantId,
                principal: this.input.principal,
                business_key: key,
              };
            },
            execute: async (approvedArgs) => {
              this.assertGrant();
              setState("pending"); // durable intent before entering effect window
              effectUnknown = true;
              const result = await activeTool.execute(approvedArgs, operationId);
              if (!result.known) return { ok: false, error: "operation_reconciliation" };
              effectUnknown = false;
              if (result.result.isError) return { ok: false, error: "tool_refused" };
              toolSucceeded = true;
              setState("settled");
              return { result: result.result };
            },
          });
          if (outcome.kind !== "executed") {
            toolRefused = true;
            return {
              isError: true,
              content: [
                { type: "text", text: effectUnknown ? "operation_reconciliation" : outcome.kind },
              ],
            };
          }
          return (
            outcome.output as { result: import("@earendil-works/pi-durable").ToolExecutionResult }
          ).result;
        },
      };
      enteredSdk = true;
      usedTokens = runtime.reservationTokens; // uncertainty never releases to zero
      const outcome = await defaultPiDurableEffectRunner({
        operationId,
        businessKey: key,
        text: input.text,
        sdk: {
          sessionFile: this.sessionFile,
          history: (limit) => this.history(limit),
          hostGate: () => {
            throw new Error("legacy gate disabled");
          },
          host,
          mode,
          runtime,
          checkGrant: () => this.assertGrant(),
          storageAdmission: this.input.storageAdmission,
        },
      });
      if (
        outcome.usedTokens !== undefined &&
        Number.isSafeInteger(outcome.usedTokens) &&
        outcome.usedTokens >= 0
      ) {
        // Confirmed SDK completion with valid observed usage and no unresolved
        // effect uses measured billing; conservative reservation remains unknown.
        usageKnown = outcome.known && !effectUnknown;
        usedTokens =
          outcome.known && !effectUnknown
            ? outcome.usedTokens
            : Math.max(runtime.reservationTokens, outcome.usedTokens);
      }
      const known = outcome.known && !effectUnknown && (mode === "converse" || toolSucceeded);
      setState(
        known || (outcome.known && toolRefused && !effectUnknown) ? "settled" : "reconciliation",
      );
      // Explicit known no-effect refusal may be retried only with a new normal approval.
      if (outcome.known && toolRefused && !effectUnknown && !toolSucceeded) {
        const journal = this.readOperations();
        journal.operations[operationId]!.reconciliation = {
          decided_at: this.nowFn(),
          outcome: "settled_no_new_effect",
        };
        this.writeOperations(journal);
        return reject("tool_not_executed");
      }
      return known
        ? { ok: true, operationId, state: "settled", turnSummary: outcome.summary }
        : { ok: false, operationId, state: "reconciliation", reason: "unknown_result_no_redrive" };
    } catch {
      // Journal IO failure is unknown and must never create an empty replacement.
      try {
        const ops = this.readOperations();
        const rec = ops.operations[operationId];
        if (rec !== undefined) {
          rec.state = "reconciliation";
          rec.updated_at = this.nowFn();
          this.writeOperations(ops);
        }
      } catch {
        /* preserve existing evidence */
      }
      return {
        ok: false,
        operationId,
        state: "reconciliation",
        reason: "unknown_result_no_redrive",
      };
    } finally {
      try {
        const journal = this.readOperations();
        const record = journal.operations[operationId];
        if (record !== undefined) {
          Object.assign(record, {
            budget_usage_known: !enteredSdk || usageKnown,
            budget_charged_tokens: enteredSdk ? usedTokens : 0,
          });
          this.writeOperations(journal);
        }
      } catch {
        /* settlement must still run exactly once even with journal IO failure */
      }
      await this.input.budgetGate.settle({
        leaseId: decision.leaseId,
        usedTokens: enteredSdk ? usedTokens : 0,
      });
    }
  }
  checkExecutionValid(operationId: string, expectedState: OperationState): boolean {
    this.assertGrant();
    return this.readOperations().operations[operationId]?.state === expectedState;
  }
  async history(limit = 50): Promise<string[]> {
    this.assertGrant();
    if (this.input.storageAdmission === undefined)
      throw new OwnerSessionError("storage_capability_required", "storage capability required");
    requireOwnerProvider(this.input.storageAdmission);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new RangeError("invalid history limit");
    const [
      { Harness, createRegistry },
      { openNodeSqliteStorage },
      { BACKGROUND_CONTEXT },
      { createModels },
    ] = await Promise.all([
      import("@earendil-works/pi-durable"),
      import("@earendil-works/pi-durable/storage/sqlite/node"),
      import("@earendil-works/chord/context"),
      import("@earendil-works/pi-ai/models"),
    ]);
    const harness = await Harness.open(
      guardOwnerStorage(await openNodeSqliteStorage(this.sessionFile), this.input.storageAdmission),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      const page = await conversation.entries({}, limit, undefined, BACKGROUND_CONTEXT);
      this.assertGrant();
      return page.items.map((e) => JSON.stringify(e));
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  }
  reconcileOperation(
    operationId: string,
    _outcome: {
      evidence?: string;
      decision: "settled_no_new_effect" | "settled_with_evidence" | "requires_manual_review";
    },
  ): OperationRecord {
    this.assertGrant();
    const ops = this.readOperations();
    const rec = ops.operations[operationId];
    if (rec?.principal_id !== this.input.principal)
      throw new OwnerSessionError(
        "operation_binding_unknown",
        "operation principal binding missing or different",
      );
    if (rec === undefined || rec.state !== "reconciliation")
      throw new OwnerSessionError("not_in_reconciliation", "operation not reconcilable");
    let result: ReturnType<NonNullable<ReconciliationVerifier["query"]>> | undefined;
    try {
      result = this.input.reconciliationVerifier?.query?.({
        operationId,
        merchantId: this.input.merchantId,
        principal: this.input.principal,
        businessKey: rec.business_key,
      });
    } catch {
      result = undefined;
    }
    this.assertGrant();
    if (
      result !== undefined &&
      result.source === this.input.reconciliationVerifier?.source &&
      typeof result.source === "string" &&
      result.source.length > 0 &&
      typeof result.receiptRef === "string" &&
      result.receiptRef.length > 0 &&
      result.operationId === operationId &&
      result.merchantId === this.input.merchantId &&
      result.principal === this.input.principal &&
      result.businessKey === rec.business_key &&
      (result.outcome === "confirmed_applied" || result.outcome === "confirmed_not_applied")
    ) {
      rec.state = "settled";
      rec.reconciliation = {
        decided_at: this.nowFn(),
        outcome:
          result.outcome === "confirmed_applied"
            ? "settled_with_evidence"
            : "settled_no_new_effect",
        evidence: result.receiptRef,
      };
    } else rec.reconciliation = { decided_at: this.nowFn(), outcome: "requires_manual_review" };
    rec.updated_at = this.nowFn();
    this.writeOperations(ops);
    return rec;
  }
  hasUnresolvedForBusinessKey(kind: string, args: unknown): boolean {
    this.assertGrant();
    const key = businessKey(kind, args);
    return Object.values(this.readOperations().operations).some(
      (r) => r.business_key === key && r.state !== "settled",
    );
  }
  storageFiles(): { operations: boolean; session: boolean; admission: boolean; lock: boolean } {
    this.assertGrant();
    return {
      operations: existsSync(this.operationsFile),
      session: existsSync(this.sessionFile),
      admission: existsSync(join(this.dataDir, "admission.json")),
      lock: existsSync(join(this.dataDir, "admission.lock")),
    };
  }
  release(): void {
    if (this.activeTurn)
      throw new OwnerSessionError("session_busy", "session busy; wait turn completion");
    if (!this.released) {
      releaseAdmissionLock(this.dataDir, this.ownershipToken);
      this.released = true;
    }
  }
}

function totalUsage(usage: import("@earendil-works/pi-durable").UsageState): number {
  let sum = 0;
  for (const entry of [...Object.values(usage.models), ...Object.values(usage.tools)]) {
    if (!Number.isSafeInteger(entry.totalTokens) || entry.totalTokens < 0)
      throw new Error("usage_unknown");
    sum += entry.totalTokens;
  }
  if (!Number.isSafeInteger(sum)) throw new Error("usage_unknown");
  return sum;
}

/** Official loop only. No default faux, local counter, custom loop or self-approval. */
export const defaultPiDurableEffectRunner: EffectRunner = async ({ text, sdk }) => {
  if (
    sdk.runtime === undefined ||
    sdk.host === undefined ||
    sdk.mode === undefined ||
    sdk.checkGrant === undefined ||
    sdk.storageAdmission === undefined
  )
    throw new OwnerSessionError(
      "sdk_runtime_configuration_required",
      "trusted SDK configuration required",
    );
  const runtime = sdk.runtime;
  const [
    { Harness, defineExtension, hook, GenerationTask },
    { openNodeSqliteStorage },
    { BACKGROUND_CONTEXT, withAbortSignal },
    { createOwnerSdkRegistry },
  ] = await Promise.all([
    import("@earendil-works/pi-durable"),
    import("@earendil-works/pi-durable/storage/sqlite/node"),
    import("@earendil-works/chord/context"),
    import("./owner-sdk-tools.js"),
  ]);
  const checkGrant = sdk.checkGrant;
  const admission = sdk.storageAdmission;
  // Before normal storage/Harness.open/openTasks (which can write recovery state).
  assertOwnerStorageReady(admission);
  let boundConversationId: number | undefined;
  let usageBefore = 0;
  let currentSpend: (() => Promise<number>) | undefined;
  let historyReader: ((limit: number) => Promise<readonly string[]>) | undefined;
  const bridge = createOwnerSdkRegistry({
    mode: sdk.mode,
    tools: runtime.tools,
    host: {
      invokeTool: async (call) => {
        checkGrant();
        if (call.conversationId !== boundConversationId)
          throw new Error("conversation_binding_mismatch");
        if (currentSpend === undefined || (await currentSpend()) >= runtime.reservationTokens)
          throw new Error("turn_budget_exhausted");
        return sdk.host!.invokeTool(call);
      },
      historyStrong: async (limit) => {
        checkGrant();
        if (historyReader === undefined) throw new Error("history unavailable");
        const rows = await historyReader(limit);
        checkGrant();
        return rows;
      },
    },
  });
  bridge.registry.install(
    defineExtension({
      name: "kiwi-owner-turn-bound",
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (_request, api) => {
            checkGrant();
            requireOwnerProvider(admission, api.conversationId);
          },
        }),
      ],
    }),
  );
  const harness = await Harness.open(
    guardOwnerStorage(await openNodeSqliteStorage(sdk.sessionFile), admission),
    {
      models: guardOwnerModels(
        runtime.models,
        admission,
        checkGrant,
        createOwnerRequestGate({
          maxRequests: runtime.maxRequests,
          reservationTokens: runtime.reservationTokens,
          currentSpend: async () => {
            if (currentSpend === undefined) throw new Error("usage_unknown");
            return currentSpend();
          },
        }),
      ),
      registry: bridge.registry,
      settings: {
        retry: { enabled: false },
        compaction: { enabled: false },
        stream: { maxRetries: 0, timeoutMs: runtime.timeoutMs },
      },
    },
    BACKGROUND_CONTEXT,
  );
  let usedTokens: number | undefined;
  try {
    const context = withAbortSignal(AbortSignal.timeout(runtime.timeoutMs), BACKGROUND_CONTEXT);
    const conversation = await harness.root(context, { agent: { model: runtime.model } });
    requireOwnerProvider(admission, conversation.id);
    boundConversationId = conversation.id;
    historyReader = async (limit) =>
      (await conversation.entries({}, limit, undefined, context)).items.map((e) =>
        JSON.stringify(e),
      );
    usageBefore = totalUsage(await harness.usage(context));
    currentSpend = async () => {
      const spend = totalUsage(await harness.usage(context)) - usageBefore;
      if (!Number.isSafeInteger(spend) || spend < 0) throw new Error("usage_unknown");
      return spend;
    };
    const submission = await conversation.submit({ type: "input", content: text }, context);
    const result = await submission.wait(context);
    usedTokens = totalUsage(await harness.usage(context)) - usageBefore;
    if (!Number.isSafeInteger(usedTokens) || usedTokens < 0) throw new Error("usage_unknown");
    return {
      known: result.status === "done",
      summary: `submission ${submission.id}: ${result.status}`,
      usedTokens,
    };
  } catch {
    try {
      usedTokens = totalUsage(await harness.usage(BACKGROUND_CONTEXT)) - usageBefore;
    } catch {
      /* keep unknown usage */
    }
    return {
      known: false,
      summary: "sdk_result_unknown",
      ...(usedTokens === undefined ? {} : { usedTokens }),
    };
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
};

// ── owner 工具工厂（C5）：创建即授权核；每次执行强读 grant；撤销后效果 0 ──

export interface OwnerToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    args: TArgs,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
}

export function defineOwnerTool<TArgs>(
  def: OwnerToolDefinition<TArgs> & {
    grantFile: string;
    merchantId: string;
    principal: string;
  },
): {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  run: (
    args: TArgs,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
} {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    async run(args: TArgs) {
      // 每次执行强读 grant（撤销后效果 0：授权失败抛 authorization_lost）。
      const check = checkFileGrant(def.grantFile, def.merchantId, def.principal);
      if (!check.ok) {
        throw new OwnerSessionError(
          "authorization_lost",
          `grant check failed: ${check.code}（工具效果 0）`,
        );
      }
      return def.execute(args);
    },
  };
}
