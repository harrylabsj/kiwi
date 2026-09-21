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
 * 商家私有管理 API（BD 设计 §9/§10/§11：`/merchant/api/*`，契约
 * `merchant-management/1`，schemas 见 contracts/merchant-management/1.0/）。
 *
 * 职责边界（BD §8.1 的「HTTP／MCP 适配层」行）：
 *   - 路由、会话→已验证主体、CSRF/Origin、输入 Schema 校验、幂等与错误映射；
 *   - **不**重写报价/审批规则：业务全部经 BD-01 `MerchantApplicationService`
 *     与 core 命令日志；本层只编排权威操作记录（§10.2 的幂等顺序）。
 *
 * 鉴权（一个部署单元 ≠ 一个权限域，红线 4）：
 *   - 会话与 /admin 同源（`MerchantAdminSessions`，kiwi_admin cookie，12h）；
 *     A2A Bearer/签名与 Catalog OAuth **不是**管理凭据（UC11）；
 *   - 写请求必须携带会话绑定的 CSRF 头（HMAC(sessionId, 进程密钥)，恒定时间
 *     比较）；请求带 Origin 时必须命中允许 origin 列表（精确匹配，BD §7.2；
 *     CORS 不是认证）；
 *   - 主体只从会话派生：正文/路径/头里的 merchant_id/actor_id 一律不认（UC10）；
 *     跨商家对象统一 404，不透露对方存在（UC09）。
 *
 * 幂等（§10.2）：先认证与归属 → 规范化输入 → 权威存储查
 * `(merchant_id, actor_id, command_type, idempotency_key)`；同键同摘要回放原
 * 回执，同键异摘要 409。校验/授权类失败在触达执行前 `release()` 回滚占位，
 * 允许修正后用原键重试；执行层异常且无法证明「未执行」→ 记 unknown 并保留
 * operation_id 查询路径（§11.1），绝不当作失败自动重做。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { WriteApprovalCandidate } from "../../agent/merchant/action-candidate.js";
import { contentHash } from "../../agent/merchant/action-candidate.js";
import type { AdminSession, MerchantAdminSessions } from "../../auth/merchant-sessions.js";
import { ADMIN_SESSION_COOKIE } from "../../auth/merchant-sessions.js";
import {
  ActorContextError,
  assertVerifiedActor,
  createVerifiedActorContext,
  hasPermission,
  type MerchantPermission,
  type VerifiedActorContext,
} from "../../merchant/application/actor.js";
import {
  MANAGEMENT_API_MAJOR,
  MANAGEMENT_ERROR_STATUS,
  ManagementError,
  MerchantApplicationService,
  type MerchantApplicationDeps,
  type MerchantProductPage,
  type OperationReceipt,
  type PageQuery,
} from "../../merchant/application/service.js";
import {
  managementRequestDigest,
  MerchantManagementOperationStore,
} from "./operation-store.js";
import type { MutableServiceState } from "./service-state.js";

const API_PREFIX = "/merchant/api";
const MAX_BODY_BYTES = 1_048_576;
/** 非候选写命令确认引用的有效期（BD §7.3：短时、单次）。 */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export interface MerchantManagementApiOptions {
  /** 本实例商家（服务端绑定；不来自请求）。 */
  merchantId: string;
  /** 当前部署代次（单代次实例恒 1；代次切换后旧代次不得再产生业务写入）。 */
  generation: () => number;
  runtimeVersion: string;
  /** 管理会话存储（与 /admin 同源：kiwi_admin cookie）。 */
  sessions: MerchantAdminSessions;
  /** 允许的写请求 Origin（精确匹配，含 scheme；请求未带 Origin 时仅 CSRF 防护）。 */
  allowedOrigins?: readonly string[];
  /** 待审批候选（core 命令日志 pending 列表）。 */
  listPending: () => WriteApprovalCandidate[];
  /** 一次性候选确认凭证签发（core 凭证存储；执行层逐项核销）。 */
  mintCandidateConfirmation: (input: {
    candidateId: string;
    candidateDigest: string;
    principalId: string;
    merchantId: string;
    action: "approve" | "reject";
  }) => string;
  /** 审批执行（core 命令日志；确认凭证由执行层核销；失败向上抛）。 */
  executeDecision: (input: {
    candidateId: string;
    actorId: string;
    merchantId: string;
    approve: boolean;
    confirmationRef: string;
    idempotencyKey: string;
  }) => Promise<void>;
  /** 当前规则版本与摘要（脱敏；缺省 → 503，不伪造规则）。 */
  policy?: () => { version: number; digest: string } | undefined;
  /** 公开商品分页投影（真实商品源接入属 BD-03；缺省 → 503，不伪造空目录）。 */
  products?: (query: PageQuery) => Promise<MerchantProductPage>;
  /** 权威操作/确认记录（state.sqlite）。 */
  operations: MerchantManagementOperationStore;
  serviceState: MutableServiceState;
  /** 就绪结论提供者（/status 与 resume 就绪门共用；只回检查名，不回细节）。 */
  readiness: () => Promise<{ ready: boolean; checks: Record<string, { ok: boolean }> }>;
  log?: (line: string) => void;
  now?: () => Date;
}

class BodyTooLarge {}

export function createMerchantManagementApiHandler(
  options: MerchantManagementApiOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const log =
    options.log ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const now = options.now ?? (() => new Date());
  const operations = options.operations;
  // CSRF 进程密钥：令牌 = HMAC(sessionId, key)。重启后页面重新拉取 /session
  // 即可取到新令牌；跨进程不可推导，持 Cookie 者本就可推导（CSRF 威胁模型成立）。
  const csrfKey = randomBytes(32);

  const baseDeps: MerchantApplicationDeps = {
    merchantId: options.merchantId,
    generation: options.generation,
    runtimeVersion: options.runtimeVersion,
    readiness: options.readiness,
    serviceState: () => options.serviceState.state,
    // 对话私有工具取决于 B07（平台动态绑定能力），未验证前一律 false（§4.2）。
    capabilities: () => ({ management_page: true, dialog_tools: false }),
    listCandidates: options.listPending,
    getCandidate: (candidateId) =>
      options.listPending().find((item) => item.candidate_id === candidateId),
    getOperation: (operationId) => operations.get(operationId, options.merchantId),
    decide: async () => {
      // 只读实例不携带执行通道；审批执行必须走 executionService（带 operationId）。
      throw new ManagementError("invalid_input", "decision execution requires the write path");
    },
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
    ...(options.products !== undefined ? { products: options.products } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  const readService = new MerchantApplicationService(baseDeps);

  /** 执行实例：deps.decide 绑定本次幂等占位的 operationId（回执可对账）。 */
  function executionService(operationId: string): MerchantApplicationService {
    return new MerchantApplicationService({
      ...baseDeps,
      decide: async (input) => {
        await options.executeDecision({
          candidateId: input.candidateId,
          actorId: input.actorId,
          merchantId: input.merchantId,
          approve: input.approve,
          confirmationRef: input.confirmationRef,
          idempotencyKey: input.idempotencyKey,
        });
        return { operationId, status: "succeeded" as const };
      },
    });
  }

  return (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      respondError(res, err);
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://merchant-management.internal");
    } catch {
      writeJson(res, 400, errorBody("invalid_input", "invalid request target"));
      return;
    }
    const pathname = url.pathname;
    if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
      writeJson(res, 404, errorBody("not_found", "unknown management api path"));
      return;
    }
    const rest = pathname === API_PREFIX ? "/" : pathname.slice(API_PREFIX.length);

    try {
      if (method === "GET") {
        await routeGet(req, res, url, rest);
        return;
      }
      if (method === "POST") {
        await routePost(req, res, rest);
        return;
      }
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        writeJson(res, 413, errorBody("invalid_input", "request body too large"));
        return;
      }
      respondError(res, err);
      return;
    }
    if (isKnownPath(rest)) {
      writeJson(res, 405, errorBody("invalid_input", "method not allowed"), { allow: "GET, POST" });
      return;
    }
    writeJson(res, 404, errorBody("not_found", "unknown management api path"));
  }

  // ── 只读路由（认证即鉴权入口；业务授权在服务层逐次复核）────────────────

  async function routeGet(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    rest: string,
  ): Promise<void> {
    if (rest === "/session") {
      const auth = requireActor(req);
      writeJson(res, 200, {
        api_version: `${MANAGEMENT_API_MAJOR}`,
        actor_id: auth.session.principal_id,
        merchant_id: auth.session.merchant_id,
        role: auth.session.role,
        expires_at: auth.session.expires_at,
        csrf_token: csrfTokenFor(auth.sessionId),
      });
      return;
    }
    if (rest === "/status") {
      const auth = requireActor(req);
      writeJson(res, 200, await readService.getStatus(auth.ctx));
      return;
    }
    if (rest === "/products") {
      const auth = requireActor(req);
      writeJson(res, 200, await readService.listProducts(auth.ctx, pageQuery(url)));
      return;
    }
    if (rest === "/policy") {
      const auth = requireActor(req);
      writeJson(res, 200, await readService.getPolicy(auth.ctx));
      return;
    }
    if (rest === "/approvals") {
      const auth = requireActor(req);
      writeJson(res, 200, await readService.listApprovals(auth.ctx, pageQuery(url)));
      return;
    }
    const approvalMatch = /^\/approvals\/([^/]+)$/.exec(rest);
    if (approvalMatch !== null) {
      const auth = requireActor(req);
      writeJson(res, 200, await readService.getApproval(auth.ctx, pathSegment(approvalMatch[1] ?? "")));
      return;
    }
    const operationMatch = /^\/operations\/([^/]+)$/.exec(rest);
    if (operationMatch !== null) {
      const auth = requireActor(req);
      writeJson(res, 200, readService.getOperation(auth.ctx, pathSegment(operationMatch[1] ?? "")));
      return;
    }
    if (isKnownPath(rest)) {
      writeJson(res, 405, errorBody("invalid_input", "method not allowed"), { allow: "POST" });
      return;
    }
    writeJson(res, 404, errorBody("not_found", "unknown management api path"));
  }

  // ── 写路由（BD §10.1；每条都过 CSRF/Origin + 幂等 + 服务层复检）──────────

  async function routePost(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
    if (rest === "/confirmations") {
      await postConfirmation(req, res);
      return;
    }
    if (rest === "/service/pause") {
      await postServicePause(req, res);
      return;
    }
    if (rest === "/service/resume") {
      await postServiceResume(req, res);
      return;
    }
    const decisionMatch = /^\/approvals\/([^/]+)\/(approve|reject)$/.exec(rest);
    if (decisionMatch !== null) {
      await postApprovalDecision(req, res, pathSegment(decisionMatch[1] ?? ""), decisionMatch[2] === "approve");
      return;
    }
    if (isKnownPath(rest)) {
      writeJson(res, 405, errorBody("invalid_input", "method not allowed"), { allow: "GET" });
      return;
    }
    writeJson(res, 404, errorBody("not_found", "unknown management api path"));
  }

  /**
   * POST /confirmations —— 生成短时单次确认引用（BD §10.1）。
   * 候选审批确认绑定候选摘要/主体/商家/动作（core 凭证存储，执行层核销）；
   * 非候选命令目前仅 service.resume（管理确认表，单次核销）。
   * **确认引用不能由普通对话工具申请**（§7.3）——本端点只接受页面会话。
   */
  async function postConfirmation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, [
      "candidate_id",
      "action",
      "arguments_hash",
      "preconditions_hash",
      "target",
      "expected_service_revision",
    ]);

    if (fields.target !== undefined || fields.expected_service_revision !== undefined) {
      const target = requireString(fields.target, "target");
      if (target !== "service.resume") {
        throw new ManagementError("invalid_input", `unsupported confirmation target: ${target}`);
      }
      authorizeOrThrow(auth.ctx, "service:resume");
      const expectedRevision = requireInteger(fields.expected_service_revision, "expected_service_revision");
      if (expectedRevision !== options.serviceState.serviceRevision) {
        throw new ManagementError("precondition_changed", "service revision changed");
      }
      const targetDigest = managementRequestDigest({ target, expected_service_revision: expectedRevision });
      const confirmation = operations.createConfirmation({
        merchantId: auth.ctx.merchantId,
        actorId: auth.ctx.actorId,
        target,
        targetDigest,
        ttlMs: CONFIRMATION_TTL_MS,
      });
      writeJson(res, 200, {
        target,
        confirmation_ref: confirmation.ref,
        expires_at: confirmation.expires_at,
      });
      return;
    }

    authorizeOrThrow(auth.ctx, "approvals:decide");
    const candidateId = requireString(fields.candidate_id, "candidate_id");
    const action = requireString(fields.action, "action");
    if (action !== "approve" && action !== "reject") {
      throw new ManagementError("invalid_input", "action must be approve or reject");
    }
    const candidate = options.listPending().find((item) => item.candidate_id === candidateId);
    if (candidate === undefined) {
      throw new ManagementError("not_found", `unknown candidate: ${candidateId}`);
    }
    if (candidate.status !== "pending_approval") {
      throw new ManagementError(
        "conflict",
        `candidate is not awaiting approval (status: ${candidate.status})`,
      );
    }
    const argumentsHash = requireString(fields.arguments_hash, "arguments_hash");
    const preconditionsHash = requireString(fields.preconditions_hash, "preconditions_hash");
    if (candidate.arguments_hash !== argumentsHash || candidate.preconditions_hash !== preconditionsHash) {
      throw new ManagementError("precondition_changed", "candidate changed since preview");
    }
    if (Date.parse(candidate.expires_at) <= now().getTime()) {
      throw new ManagementError("precondition_changed", "candidate has expired");
    }
    const confirmationRef = options.mintCandidateConfirmation({
      candidateId,
      candidateDigest: contentHash({ arguments: candidate.arguments, preconditions: candidate.preconditions }),
      principalId: auth.session.principal_id,
      merchantId: auth.session.merchant_id,
      action,
    });
    writeJson(res, 200, {
      target: "approval",
      candidate_id: candidateId,
      action,
      confirmation_ref: confirmationRef,
      expires_at: candidate.expires_at,
    });
  }

  /** POST /approvals/{id}/approve|reject —— 幂等占位 → 服务层复检 → 执行 → 落回执。 */
  async function postApprovalDecision(
    req: IncomingMessage,
    res: ServerResponse,
    candidateId: string,
    approve: boolean,
  ): Promise<void> {
    const commandType = `approval.${approve ? "approve" : "reject"}`;
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, [
      "arguments_hash",
      "preconditions_hash",
      "confirmation_ref",
      "reason",
      "idempotency_key",
    ]);
    const argumentsHash = requireString(fields.arguments_hash, "arguments_hash");
    const preconditionsHash = requireString(fields.preconditions_hash, "preconditions_hash");
    const confirmationRef = requireString(fields.confirmation_ref, "confirmation_ref");
    const idempotencyKey = requireString(fields.idempotency_key, "idempotency_key");
    const reason = optionalString(fields.reason, "reason");

    const requestDigest = managementRequestDigest({
      candidate_id: candidateId,
      arguments_hash: argumentsHash,
      preconditions_hash: preconditionsHash,
      confirmation_ref: confirmationRef,
      ...(reason !== undefined ? { reason } : {}),
    });
    const begun = operations.begin({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType,
      idempotencyKey,
      requestDigest,
    });
    if (begun.kind === "replay") {
      writeJson(res, 200, begun.receipt);
      return;
    }
    if (begun.kind === "conflict") {
      writeJson(res, 409, errorBody("conflict", "idempotency key was already used with a different request"));
      return;
    }

    try {
      // expected_revision 传 0：本版契约用 arguments/preconditions 哈希作为
      // 条件更新证明（BD §11.2 的等价机制；候选对象暂无持久 revision 字段）。
      const receipt = await executionService(begun.operationId).decideApproval(
        auth.ctx,
        candidateId,
        {
          expected_revision: 0,
          arguments_hash: argumentsHash,
          preconditions_hash: preconditionsHash,
          confirmation_ref: confirmationRef,
        },
        { approve, idempotencyKey, ...(reason !== undefined ? { reason } : {}) },
      );
      operations.complete(begun.operationId, toStorageStatus(receipt.status), receipt);
      writeJson(res, 200, receipt);
      return;
    } catch (err) {
      if (err instanceof ManagementError) {
        // 校验/授权/摘要/状态/过期类失败：未触达执行 → 释放占位，原键可重试。
        operations.release(begun.operationId);
        respondError(res, err);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("确认凭证")) {
        // core 凭证校验拒绝 = 未执行（凭证未被核销）：释放占位，重新签确认后原键可重试。
        operations.release(begun.operationId);
        respondError(res, new ManagementError("forbidden", "confirmation reference is invalid or expired"));
        return;
      }
      // 无法证明「未执行」→ 记 unknown，保留对账路径（BD §11.1），绝不自动重做。
      log(`[merchant-management] ${commandType} 执行异常：${message}\n`);
      const receipt = staticReceipt(begun.operationId, commandType, "unknown");
      operations.complete(begun.operationId, "unknown", receipt);
      respondError(
        res,
        new ManagementError(
          "unavailable",
          `execution outcome unknown; query operation ${begun.operationId} before retrying`,
        ),
      );
    }
  }

  /** POST /service/pause —— 拒新询价；既有任务不受影响（T012 语义）。 */
  async function postServicePause(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, ["reason", "expected_service_revision", "idempotency_key"]);
    authorizeOrThrow(auth.ctx, "service:pause");
    const expectedRevision = requireInteger(fields.expected_service_revision, "expected_service_revision");
    const idempotencyKey = requireString(fields.idempotency_key, "idempotency_key");
    const reason = optionalString(fields.reason, "reason");
    if (expectedRevision !== options.serviceState.serviceRevision) {
      throw new ManagementError("precondition_changed", "service revision changed");
    }

    const begun = operations.begin({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType: "service.pause",
      idempotencyKey,
      requestDigest: managementRequestDigest({
        expected_service_revision: expectedRevision,
        ...(reason !== undefined ? { reason } : {}),
      }),
    });
    if (begun.kind === "replay") {
      writeJson(res, 200, begun.receipt);
      return;
    }
    if (begun.kind === "conflict") {
      writeJson(res, 409, errorBody("conflict", "idempotency key was already used with a different request"));
      return;
    }
    try {
      const applied = options.serviceState.pause(reason);
      const receipt: OperationReceipt = {
        ...staticReceipt(begun.operationId, "service.pause", "succeeded"),
        resource_ref: "service",
        result_revision: applied.service_revision,
        completed_at: now().toISOString(),
      };
      operations.complete(begun.operationId, "succeeded", receipt);
      writeJson(res, 200, receipt);
      return;
    } catch (err) {
      if (err instanceof ManagementError) {
        operations.release(begun.operationId);
        respondError(res, err);
        return;
      }
      throw err;
    }
  }

  /** POST /service/resume —— owner 专属 + 确认引用 + 就绪门（BD §10.1）。 */
  async function postServiceResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, [
      "expected_service_revision",
      "confirmation_ref",
      "idempotency_key",
    ]);
    authorizeOrThrow(auth.ctx, "service:resume");
    const expectedRevision = requireInteger(fields.expected_service_revision, "expected_service_revision");
    const confirmationRef = requireString(fields.confirmation_ref, "confirmation_ref");
    const idempotencyKey = requireString(fields.idempotency_key, "idempotency_key");
    if (expectedRevision !== options.serviceState.serviceRevision) {
      throw new ManagementError("precondition_changed", "service revision changed");
    }
    // 确认引用在触达执行前核销（单次）；失败 = 未授权确认 → 403，不留占位。
    if (
      !operations.consumeConfirmation({
        ref: confirmationRef,
        merchantId: auth.ctx.merchantId,
        actorId: auth.ctx.actorId,
        target: "service.resume",
        targetDigest: managementRequestDigest({
          target: "service.resume",
          expected_service_revision: expectedRevision,
        }),
      })
    ) {
      throw new ManagementError("forbidden", "confirmation reference is invalid or expired");
    }

    const begun = operations.begin({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType: "service.resume",
      idempotencyKey,
      requestDigest: managementRequestDigest({ expected_service_revision: expectedRevision }),
    });
    if (begun.kind === "replay") {
      writeJson(res, 200, begun.receipt);
      return;
    }
    if (begun.kind === "conflict") {
      writeJson(res, 409, errorBody("conflict", "idempotency key was already used with a different request"));
      return;
    }
    // 就绪门：恢复前重新取就绪结论；失败/异常都发生在迁移之前 → 释放占位。
    let readiness: { ready: boolean; checks: Record<string, { ok: boolean }> };
    try {
      readiness = await options.readiness();
    } catch {
      operations.release(begun.operationId);
      respondError(res, new ManagementError("unavailable", "readiness check failed; refusing to resume"));
      return;
    }
    const failedChecks = Object.entries(readiness.checks)
      .filter(([, check]) => !check.ok)
      .map(([name]) => name);
    try {
      const applied = options.serviceState.resume(readiness.ready, failedChecks);
      const receipt: OperationReceipt = {
        ...staticReceipt(begun.operationId, "service.resume", "succeeded"),
        resource_ref: "service",
        result_revision: applied.service_revision,
        completed_at: now().toISOString(),
      };
      operations.complete(begun.operationId, "succeeded", receipt);
      writeJson(res, 200, receipt);
      return;
    } catch (err) {
      if (err instanceof ManagementError) {
        operations.release(begun.operationId);
        respondError(res, err);
        return;
      }
      throw err;
    }
  }

  // ── 认证与防护 ─────────────────────────────────────────────────────

  function requireActor(req: IncomingMessage): {
    sessionId: string;
    session: AdminSession;
    ctx: VerifiedActorContext;
  } {
    const sessionId = cookieValue(req, ADMIN_SESSION_COOKIE);
    const session = sessionId !== undefined ? options.sessions.getSession(sessionId) : undefined;
    if (sessionId === undefined || session === undefined) {
      throw new ManagementError("unauthorized", "management session required");
    }
    const ctx = createVerifiedActorContext({
      actorId: session.principal_id,
      merchantId: session.merchant_id,
      role: session.role,
      authMethod: "admin-session",
      generation: options.generation(),
      requestId: `mreq_${randomBytes(8).toString("hex")}`,
      expiresAt: session.expires_at,
    });
    return { sessionId, session, ctx };
  }

  /**
   * 适配层授权门（confirmations/pause/resume 在进入服务层之前先挡越权；
   * 服务层仍逐次复检——两层都要过，类型检查通过不算授权）。
   */
  function authorizeOrThrow(ctx: VerifiedActorContext, permission: MerchantPermission): void {
    const actor = assertVerifiedActor(ctx, now());
    if (!hasPermission(actor, permission)) {
      throw new ManagementError("forbidden", `missing permission: ${permission}`);
    }
    if (actor.merchantId !== options.merchantId) {
      throw new ManagementError("not_found", "resource does not belong to this merchant");
    }
  }

  function assertWriteGuards(req: IncomingMessage, sessionId: string): void {
    const presented = singleHeader(req, "x-csrf-token");
    if (!csrfValid(sessionId, presented)) {
      throw new ManagementError("forbidden", "missing or invalid CSRF token");
    }
    const origin = singleHeader(req, "origin");
    if (
      origin !== undefined &&
      options.allowedOrigins !== undefined &&
      !options.allowedOrigins.includes(origin)
    ) {
      throw new ManagementError("forbidden", "origin is not allowed for management writes");
    }
  }

  function csrfTokenFor(sessionId: string): string {
    return createHmac("sha256", csrfKey).update(sessionId).digest("base64url");
  }

  function csrfValid(sessionId: string, presented: string | undefined): boolean {
    if (presented === undefined || presented === "") return false;
    const expected = Buffer.from(csrfTokenFor(sessionId));
    const actual = Buffer.from(presented);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  // ── 输入与输出辅助 ─────────────────────────────────────────────────

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) {
      throw new ManagementError("invalid_input", "JSON body required");
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ManagementError("invalid_input", "body must be valid JSON");
    }
  }

  function staticReceipt(
    operationId: string,
    commandType: string,
    status: OperationReceipt["status"],
  ): OperationReceipt {
    const stamp = now().toISOString();
    return {
      operation_id: operationId,
      command_type: commandType,
      status,
      resource_ref: null,
      result_revision: null,
      created_at: stamp,
      ...(status === "succeeded" || status === "failed" ? { completed_at: stamp } : { completed_at: null }),
      support_id: `sup_${operationId.slice(-8)}`,
    };
  }

  function toStorageStatus(status: OperationReceipt["status"]): "succeeded" | "failed" | "unknown" {
    if (status === "succeeded" || status === "failed") return status;
    return "unknown";
  }
}

// ── 模块级纯函数 ───────────────────────────────────────────────────────

function isKnownPath(rest: string): boolean {
  if (
    rest === "/session" ||
    rest === "/status" ||
    rest === "/products" ||
    rest === "/policy" ||
    rest === "/approvals" ||
    rest === "/confirmations" ||
    rest === "/service/pause" ||
    rest === "/service/resume"
  ) {
    return true;
  }
  return /^\/approvals\/[^/]+(\/approve|\/reject)?$/.test(rest) || /^\/operations\/[^/]+$/.test(rest);
}

function pageQuery(url: URL): PageQuery {
  const out: { cursor?: string; limit?: number } = {};
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && cursor !== "") out.cursor = cursor;
  const limitRaw = url.searchParams.get("limit");
  if (limitRaw !== null) {
    const limit = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new ManagementError("invalid_input", "limit must be a positive integer");
    }
    out.limit = limit;
  }
  return out;
}

function pathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ManagementError("invalid_input", "invalid path encoding");
  }
}

function objectFields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ManagementError("invalid_input", "body must be a JSON object");
  }
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      throw new ManagementError("invalid_input", `unknown field: ${key}`);
    }
  }
  return body as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ManagementError("invalid_input", `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ManagementError("invalid_input", `${field} must be an integer`);
  }
  return value;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function errorBody(
  code: string,
  message: string,
  opts: { retryable?: boolean; supportId?: string } = {},
): Record<string, unknown> {
  return {
    code,
    message,
    retryable: opts.retryable ?? false,
    support_id: opts.supportId ?? `sup_${randomBytes(4).toString("hex")}`,
  };
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function respondError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof ActorContextError) {
    if (err.code === "expired_context") {
      writeJson(res, 401, errorBody("unauthorized", "management session or actor context expired"));
      return;
    }
    process.stderr.write(`[merchant-management] 主体上下文完整性异常：${err.message}\n`);
    writeJson(res, 503, errorBody("unavailable", "actor context integrity failure"));
    return;
  }
  if (err instanceof ManagementError) {
    writeJson(
      res,
      MANAGEMENT_ERROR_STATUS[err.code],
      errorBody(err.code, err.message, { retryable: err.retryable, supportId: err.supportId }),
    );
    return;
  }
  process.stderr.write(
    `[merchant-management] 未预期异常：${err instanceof Error ? err.message : String(err)}\n`,
  );
  writeJson(res, 503, errorBody("unavailable", "internal error"));
}
