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
  parseProductTable,
  ProductTableError,
  productTableDigest,
  type CloudProductRecord,
  type CloudProductTable,
} from "../../cloud/product-source.js";
import { MerchantImportDraftStore } from "./draft-store.js";
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
import { OnboardingStore } from "../../cloud/onboarding/store.js";
import { requestsDisabledLocalImplementation } from "../../cloud/onboarding/local-fallback.js";
import { checkStepSubmission, planWizard, WIZARD_STEPS } from "../../cloud/onboarding/steps.js";
import type { Evidence, PlatformEvidenceResult } from "../../cloud/onboarding/types.js";
import { createWorkbenchProblem, type WorkbenchProblemCode } from "./problem.js";
import {
  WorkbenchConfirmationError,
  type WebAuthnAssertionInput,
  type WorkbenchConfirmationStore,
} from "./webauthn-confirmation.js";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { BROADCAST_TOOLS } from "../../merchant/feed-executors.js";
import { MerchantFeedError, type MerchantFeedStore } from "../../merchant/feed-store.js";
import {
  MerchantGrantError,
  type MerchantGrantStore,
} from "../../merchant/grant-store.js";

const API_PREFIX = "/merchant/api";
const WORKBENCH_API_PREFIX = "/merchant/api/v1";
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
  /**
   * 商品导入落盘通道（配置 KIWI_CLOUD_PRODUCTS_FILE 后可用；缺省 → 503）。
   * currentTable 供预览与 CAS 基准；commit 必须**原子**（temp+rename，
   * 全批成功或全批不变，BD §10.1）。
   */
  productsImport?: {
    currentTable: () => { digest: string; records: CloudProductRecord[] };
    commit: (table: CloudProductTable) => { digest: string };
  };
  /** 策略草稿提交（MerchantPolicyRuntime.apply；缺省 → 503）。回执只含版本与摘要。 */
  policyApply?: (patch: Record<string, unknown>) => Promise<{ version: number; digest: string }>;
  /** 管理草稿存储（权威存储；**策略草稿原文不出现在任何 API 响应**，红线 6）。 */
  drafts: MerchantImportDraftStore;
  /** 权威操作/确认记录（state.sqlite）。 */
  operations: MerchantManagementOperationStore;
  serviceState: MutableServiceState;
  /** 就绪结论提供者（/status 与 resume 就绪门共用；只回检查名，不回细节）。 */
  readiness: () => Promise<{ ready: boolean; checks: Record<string, { ok: boolean }> }>;
  /**
   * 开通向导（M4 §5.4；读写同一份 `OnboardingStore`）。
   *
   * **权威证据只从 `platformEvidence` 取**（服务端适配器），**绝不接受请求体自报**——
   * 否则客户端就能伪造"平台查询回执"，正是 T029 要挡的事。未配置该适配器时：
   * 需要权威证据的步骤一律 **503**（不推进），确定性步骤（登录绑定）照常可走。
   */
  onboarding?: {
    store: OnboardingStore;
    platformEvidence?: (input: {
      stepId: string;
      recordId: string;
      /** 平台报告的 applicationId（适配器从真实回执里取，不来自请求）。 */
    }) => Promise<PlatformEvidenceResult>;
  };
  /** Workbench v1 trusted confirmation authority; absent means strong-confirmation routes fail closed. */
  workbenchConfirmations?: WorkbenchConfirmationStore;
  /** Workbench Feed authority. Writes remain candidate-only through the prepare callbacks. */
  workbenchFeed?: MerchantFeedStore;
  /** Scoped Operator grant authority (owner is explicitly exempt from scoped grants). */
  workbenchGrants?: MerchantGrantStore;
  prepareBroadcastPublish?: (input: {
    broadcast: Record<string, unknown>;
    authorization: Record<string, unknown>;
    reason?: string;
  }) => Promise<unknown> | unknown;
  prepareBroadcastRevise?: (input: {
    broadcastId: string;
    expectedRevision: number;
    broadcast: Record<string, unknown>;
    authorization: Record<string, unknown>;
    reason?: string;
  }) => Promise<unknown> | unknown;
  prepareBroadcastWithdraw?: (input: {
    broadcastId: string;
    expectedRevision: number;
    authorization: Record<string, unknown>;
    reason?: string;
  }) => Promise<unknown> | unknown;
  /** Independent registration authorization. Management session alone must never satisfy this callback. */
  webauthnRegistration?: {
    rpName: string;
    rpId: string;
    origin: string;
    authorize: (
      request: IncomingMessage,
      actor: VerifiedActorContext,
    ) => boolean | Promise<boolean>;
  };
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
    if (pathname === WORKBENCH_API_PREFIX || pathname.startsWith(`${WORKBENCH_API_PREFIX}/`)) {
      const requestId = `req_${randomBytes(12).toString("hex")}`;
      const rest =
        pathname === WORKBENCH_API_PREFIX ? "/" : pathname.slice(WORKBENCH_API_PREFIX.length);
      try {
        if (method === "GET") {
          await routeWorkbenchV1Get(req, res, url, rest, requestId);
          return;
        }
        if (method === "POST") {
          await routeWorkbenchV1Post(req, res, rest, requestId);
          return;
        }
        {
          writeWorkbenchProblem(
            res,
            "VALIDATION_ERROR",
            requestId,
            "请求方法不可用",
            "该 Workbench 路由当前只接受 GET/POST。",
            { allow: "GET, POST" },
          );
          return;
        }
      } catch (error) {
        respondWorkbenchError(res, error, requestId);
      }
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

  /** Workbench v1 读取面复用同一应用服务；未实现路由明确失败，不返回假数据。 */
  async function routeWorkbenchV1Get(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    rest: string,
    requestId: string,
  ): Promise<void> {
    if (rest === "/runtime/status") {
      const auth = requireActor(req);
      writeJson(res, 200, await readService.getStatus(auth.ctx), { "x-request-id": requestId });
      return;
    }
    // `/products` 暂不复用 legacy major-unit Number 投影。Workbench v1 要求
    // currency + amount_minor 十进制整数字符串；精确数据源接线前明确 404，不能把
    // 旧浮点价格重新包装成“精确金额”。
    if (rest === "/approvals") {
      const auth = requireActor(req);
      writeJson(res, 200, await readService.listApprovals(auth.ctx, pageQuery(url)), {
        "x-request-id": requestId,
      });
      return;
    }
    if (rest === "/broadcasts") {
      const auth = requireActor(req);
      authorizeOrThrow(auth.ctx, "approvals:read");
      const feed = requireWorkbenchFeed();
      writeJson(
        res,
        200,
        feed.listBroadcasts(auth.ctx.merchantId, pageQuery(url)),
        { "x-request-id": requestId },
      );
      return;
    }
    const broadcastMatch = /^\/broadcasts\/([^/]+)$/.exec(rest);
    if (broadcastMatch !== null) {
      const auth = requireActor(req);
      authorizeOrThrow(auth.ctx, "approvals:read");
      const value = requireWorkbenchFeed().getBroadcast(
        auth.ctx.merchantId,
        pathSegment(broadcastMatch[1] ?? ""),
      );
      if (value === undefined) throw new ManagementError("not_found", "unknown broadcast");
      writeJson(res, 200, value, { "x-request-id": requestId });
      return;
    }
    const approvalMatch = /^\/approvals\/([^/]+)$/.exec(rest);
    if (approvalMatch !== null) {
      const auth = requireActor(req);
      writeJson(
        res,
        200,
        await readService.getApproval(auth.ctx, pathSegment(approvalMatch[1] ?? "")),
        { "x-request-id": requestId },
      );
      return;
    }
    const operationMatch = /^\/operations\/([^/]+)$/.exec(rest);
    if (operationMatch !== null) {
      const auth = requireActor(req);
      writeJson(
        res,
        200,
        readService.getOperation(auth.ctx, pathSegment(operationMatch[1] ?? "")),
        { "x-request-id": requestId },
      );
      return;
    }
    const confirmationMatch = /^\/confirmations\/([^/]+)$/.exec(rest);
    if (confirmationMatch !== null) {
      const auth = requireActor(req);
      writeJson(
        res,
        200,
        requireWorkbenchConfirmations().requestProjection({
          confirmationId: pathSegment(confirmationMatch[1] ?? ""),
          merchantId: auth.ctx.merchantId,
          actorId: auth.ctx.actorId,
        }),
        { "x-request-id": requestId },
      );
      return;
    }
    const confirmationRefMatch = /^\/confirmations\/by-ref\/([^/]+)$/.exec(rest);
    if (confirmationRefMatch !== null) {
      const auth = requireActor(req);
      writeJson(
        res,
        200,
        requireWorkbenchConfirmations().requestProjectionByRef({
          requestRef: pathSegment(confirmationRefMatch[1] ?? ""),
          merchantId: auth.ctx.merchantId,
          actorId: auth.ctx.actorId,
        }),
        { "x-request-id": requestId },
      );
      return;
    }
    writeWorkbenchProblem(
      res,
      "RESOURCE_NOT_FOUND",
      requestId,
      "资源不存在",
      "Workbench API 路由不存在或尚未实现。",
    );
  }

  async function routeWorkbenchV1Post(
    req: IncomingMessage,
    res: ServerResponse,
    rest: string,
    requestId: string,
  ): Promise<void> {
    if (rest === "/webauthn/registrations/options") {
      const auth = requireActor(req);
      assertWriteGuards(req, auth.sessionId);
      const registration = await requireRegistrationAuthorization(req, auth.ctx);
      const begun = await requireWorkbenchConfirmations().beginCredentialRegistration({
        merchantId: auth.ctx.merchantId,
        actorId: auth.ctx.actorId,
        rpName: registration.rpName,
        rpId: registration.rpId,
        origin: registration.origin,
        userName: auth.ctx.actorId,
        userDisplayName: auth.ctx.actorId,
      });
      writeJson(res, 201, begun, { "x-request-id": requestId });
      return;
    }

    const registrationVerify = /^\/webauthn\/registrations\/([^/]+)\/verify$/.exec(rest);
    if (registrationVerify !== null) {
      const auth = requireActor(req);
      assertWriteGuards(req, auth.sessionId);
      await requireRegistrationAuthorization(req, auth.ctx);
      const body = await readJsonBody(req);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new ManagementError("invalid_input", "registration response must be an object");
      }
      const result = await requireWorkbenchConfirmations().finishCredentialRegistration({
        registrationId: pathSegment(registrationVerify[1] ?? ""),
        merchantId: auth.ctx.merchantId,
        actorId: auth.ctx.actorId,
        response: body as unknown as RegistrationResponseJSON,
      });
      writeJson(res, 201, result, { "x-request-id": requestId });
      return;
    }

    if (rest === "/confirmations") {
      const auth = requireActor(req);
      assertWriteGuards(req, auth.sessionId);
      authorizeOrThrow(auth.ctx, "approvals:decide");
      const confirmations = requireWorkbenchConfirmations();
      if (!confirmations.hasUsableCredential(auth.ctx.merchantId, auth.ctx.actorId)) {
        throw new WorkbenchConfirmationError(
          "credential_unavailable",
          "actor has no verified WebAuthn credential",
        );
      }
      const fields = objectFields(await readJsonBody(req), ["candidate_id", "decision"]);
      const candidateId = requireString(fields["candidate_id"], "candidate_id");
      const decision = requireDecision(fields["decision"]);
      const candidate = options.listPending().find((item) => item.candidate_id === candidateId);
      if (candidate === undefined || candidate.status !== "pending_approval") {
        throw new ManagementError("not_found", `unknown pending candidate: ${candidateId}`);
      }
      const expiresAt = new Date(
        Math.min(Date.parse(candidate.expires_at), now().getTime() + CONFIRMATION_TTL_MS),
      ).toISOString();
      const decisionAuthorization = authorizeBroadcastCandidate(auth.ctx, candidate, "broadcast.decide");
      const confirmation = confirmations.createRequest({
        merchantId: auth.ctx.merchantId,
        actorId: auth.ctx.actorId,
        candidateId,
        approvalGeneration: 1,
        decision,
        operationId: `wop_${randomBytes(16).toString("hex")}`,
        actionDigest: contentHash({
          arguments: candidate.arguments,
          preconditions: candidate.preconditions,
        }),
        actionSnapshot: {
          merchant_id: auth.ctx.merchantId,
          candidate_id: candidateId,
          decision,
          tool: candidate.tool,
          arguments: candidate.arguments,
          preconditions: candidate.preconditions,
          risk: candidate.risk,
          candidate_expires_at: candidate.expires_at,
          ...(decisionAuthorization !== undefined
            ? { decision_authorization: decisionAuthorization }
            : {}),
        },
        expectedVersion: 1,
        expiresAt,
      });
      writeJson(
        res,
        201,
        {
          confirmation_id: confirmation.confirmationId,
          request_ref: confirmation.requestRef,
          expires_at: confirmation.expiresAt,
        },
        { "x-request-id": requestId },
      );
      return;
    }

    const optionsMatch = /^\/confirmations\/([^/]+)\/assertion-options$/.exec(rest);
    if (optionsMatch !== null) {
      const auth = requireActor(req);
      assertWriteGuards(req, auth.sessionId);
      writeJson(
        res,
        200,
        requireWorkbenchConfirmations().assertionOptions({
          confirmationId: pathSegment(optionsMatch[1] ?? ""),
          merchantId: auth.ctx.merchantId,
          actorId: auth.ctx.actorId,
        }),
        { "x-request-id": requestId },
      );
      return;
    }

    const decisionMatch = /^\/approvals\/([^/]+)\/decisions$/.exec(rest);
    if (decisionMatch !== null) {
      const auth = requireActor(req);
      assertWriteGuards(req, auth.sessionId);
      authorizeOrThrow(auth.ctx, "approvals:decide");
      const candidateId = pathSegment(decisionMatch[1] ?? "");
      const fields = objectFields(await readJsonBody(req), [
        "confirmation_id",
        "decision",
        "expected_version",
        "assertion",
      ]);
      const assertionFields = objectFields(fields["assertion"], [
        "credential_id",
        "client_data_json",
        "authenticator_data",
        "signature",
      ]);
      const assertion: WebAuthnAssertionInput = {
        credentialId: requireString(assertionFields["credential_id"], "credential_id"),
        clientDataJSON: requireString(assertionFields["client_data_json"], "client_data_json"),
        authenticatorData: requireString(assertionFields["authenticator_data"], "authenticator_data"),
        signature: requireString(assertionFields["signature"], "signature"),
      };
      const candidate = options.listPending().find((item) => item.candidate_id === candidateId);
      if (candidate === undefined || candidate.status !== "pending_approval") {
        throw new ManagementError("not_found", `unknown pending candidate: ${candidateId}`);
      }
      const currentAuthorization = authorizeBroadcastCandidate(
        auth.ctx,
        candidate,
        "broadcast.decide",
      );
      if (currentAuthorization !== undefined) {
        const confirmationId = requireString(fields["confirmation_id"], "confirmation_id");
        const frozen = requireWorkbenchConfirmations().requestProjection({
          confirmationId,
          merchantId: auth.ctx.merchantId,
          actorId: auth.ctx.actorId,
        }).snapshot["decision_authorization"];
        if (!sameAuthorizationGeneration(frozen, currentAuthorization)) {
          throw new ManagementError(
            "forbidden",
            "broadcast authorization changed after confirmation was created",
          );
        }
      }
      const outcome = requireWorkbenchConfirmations().finalizeDecision({
        confirmationId: requireString(fields["confirmation_id"], "confirmation_id"),
        merchantId: auth.ctx.merchantId,
        actorId: auth.ctx.actorId,
        candidateId,
        approvalGeneration: 1,
        decision: requireDecision(fields["decision"]),
        actionDigest: contentHash({
          arguments: candidate.arguments,
          preconditions: candidate.preconditions,
        }),
        expectedVersion: requireInteger(fields["expected_version"], "expected_version"),
        assertion,
      });
      writeJson(
        res,
        outcome.kind === "decided" ? 202 : 200,
        {
          operation_id: outcome.operationId,
          status: outcome.kind === "decided" ? "accepted" : "already_decided",
          decision: outcome.decision,
          ...(outcome.kind === "already_decided" ? { decided_by: outcome.actorId } : {}),
        },
        { "x-request-id": requestId },
      );
      return;
    }

    if (rest === "/broadcasts/drafts") {
      const auth = requireActor(req);
      assertWriteGuards(req, auth.sessionId);
      authorizeOrThrow(auth.ctx, "broadcast:draft");
      const fields = objectFields(await readJsonBody(req), [
        "action",
        "broadcast_id",
        "expected_revision",
        "broadcast",
        "reason",
      ]);
      const action = requireString(fields["action"], "action");
      if (action !== "publish" && action !== "revise" && action !== "withdraw") {
        throw new ManagementError("invalid_input", "action must be publish, revise or withdraw");
      }
      const scoped = authorizeBroadcastAction(auth.ctx, "broadcast.draft");
      const authorization: Record<string, unknown> = {
        actor_id: auth.ctx.actorId,
        actor_role: auth.ctx.role,
        action: "broadcast.draft",
        authorization_generation: scoped.generation,
        matched_grant_ids: scoped.grantIds,
      };
      const reason = optionalString(fields["reason"], "reason");
      let prepared: unknown;
      if (action === "publish") {
        const channel = options.prepareBroadcastPublish;
        if (channel === undefined) throw new ManagementError("unavailable", "broadcast prepare is unavailable");
        prepared = await channel({
          broadcast: requireObject(fields["broadcast"], "broadcast"),
          authorization,
          ...(reason !== undefined ? { reason } : {}),
        });
      } else if (action === "revise") {
        const channel = options.prepareBroadcastRevise;
        if (channel === undefined) throw new ManagementError("unavailable", "broadcast prepare is unavailable");
        prepared = await channel({
          broadcastId: requireString(fields["broadcast_id"], "broadcast_id"),
          expectedRevision: requireInteger(fields["expected_revision"], "expected_revision"),
          broadcast: requireObject(fields["broadcast"], "broadcast"),
          authorization,
          ...(reason !== undefined ? { reason } : {}),
        });
      } else {
        const channel = options.prepareBroadcastWithdraw;
        if (channel === undefined) throw new ManagementError("unavailable", "broadcast prepare is unavailable");
        prepared = await channel({
          broadcastId: requireString(fields["broadcast_id"], "broadcast_id"),
          expectedRevision: requireInteger(fields["expected_revision"], "expected_revision"),
          authorization,
          ...(reason !== undefined ? { reason } : {}),
        });
      }
      writeJson(res, 201, prepared, { "x-request-id": requestId });
      return;
    }

    writeWorkbenchProblem(
      res,
      "RESOURCE_NOT_FOUND",
      requestId,
      "资源不存在",
      "Workbench 写路由不存在或尚未实现。",
    );
  }

  function requireWorkbenchConfirmations(): WorkbenchConfirmationStore {
    if (options.workbenchConfirmations === undefined) {
      throw new WorkbenchConfirmationError(
        "credential_unavailable",
        "trusted confirmation channel is not configured",
      );
    }
    return options.workbenchConfirmations;
  }

  function requireWorkbenchFeed(): MerchantFeedStore {
    if (options.workbenchFeed === undefined) {
      throw new ManagementError("unavailable", "Workbench Feed authority is not configured");
    }
    return options.workbenchFeed;
  }

  function authorizeBroadcastAction(
    actor: VerifiedActorContext,
    action: "broadcast.draft" | "broadcast.decide",
  ): { generation: number; grantIds: string[] } {
    if (actor.role === "owner") {
      return {
        generation: options.workbenchGrants?.authorizationGeneration(actor.merchantId, actor.actorId) ?? 0,
        grantIds: [],
      };
    }
    const grants = options.workbenchGrants;
    if (grants === undefined) throw new ManagementError("forbidden", "scoped grants are unavailable");
    const result = grants.authorize(actor, { action, resourceType: "merchant" });
    if (!result.authorized) throw new ManagementError("forbidden", `missing scoped grant: ${action}`);
    return { generation: result.generation, grantIds: result.grantIds };
  }

  function authorizeBroadcastCandidate(
    actor: VerifiedActorContext,
    candidate: WriteApprovalCandidate,
    action: "broadcast.decide",
  ): Record<string, unknown> | undefined {
    if (!Object.values(BROADCAST_TOOLS).includes(candidate.tool as (typeof BROADCAST_TOOLS)[keyof typeof BROADCAST_TOOLS])) {
      return undefined;
    }
    authorizeOrThrow(actor, "broadcast:decide");
    const scoped = authorizeBroadcastAction(actor, action);
    return {
      actor_id: actor.actorId,
      actor_role: actor.role,
      action,
      authorization_generation: scoped.generation,
      matched_grant_ids: scoped.grantIds,
    };
  }

  async function requireRegistrationAuthorization(
    req: IncomingMessage,
    actor: VerifiedActorContext,
  ): Promise<NonNullable<MerchantManagementApiOptions["webauthnRegistration"]>> {
    const registration = options.webauthnRegistration;
    if (registration === undefined || !(await registration.authorize(req, actor))) {
      throw new WorkbenchConfirmationError(
        "credential_unavailable",
        "independent WebAuthn registration authorization is unavailable",
      );
    }
    return registration;
  }

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
    if (rest === "/onboarding") {
      const auth = requireActor(req);
      authorizeOrThrow(auth.ctx, "onboarding:manage");
      const channel = onboardingChannel();
      const record = channel.store.activeRecord(auth.ctx.merchantId) ?? null;
      writeJson(res, 200, { record, plan: record === null ? null : planWizard(record) });
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
    if (rest === "/onboarding/intents") {
      await postOnboardingIntent(req, res);
      return;
    }
    const advanceMatch = /^\/onboarding\/([^/]+)\/advance$/.exec(rest);
    if (advanceMatch !== null) {
      await postOnboardingAdvance(req, res, pathSegment(advanceMatch[1] ?? ""));
      return;
    }
    const cancelMatch = /^\/onboarding\/([^/]+)\/cancel$/.exec(rest);
    if (cancelMatch !== null) {
      await postOnboardingCancel(req, res, pathSegment(cancelMatch[1] ?? ""));
      return;
    }
    const refusedMatch = /^\/onboarding\/([^/]+)\/consent-refused$/.exec(rest);
    if (refusedMatch !== null) {
      await postOnboardingConsentRefused(req, res, pathSegment(refusedMatch[1] ?? ""));
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
    if (rest === "/products/import-drafts") {
      await postProductsImportDraft(req, res);
      return;
    }
    const importCommitMatch = /^\/products\/import-drafts\/([^/]+)\/commit$/.exec(rest);
    if (importCommitMatch !== null) {
      await postProductsImportCommit(req, res, pathSegment(importCommitMatch[1] ?? ""));
      return;
    }
    if (rest === "/policy/drafts") {
      await postPolicyDraft(req, res);
      return;
    }
    const policyCommitMatch = /^\/policy\/drafts\/([^/]+)\/commit$/.exec(rest);
    if (policyCommitMatch !== null) {
      await postPolicyCommit(req, res, pathSegment(policyCommitMatch[1] ?? ""));
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

  // ── 开通向导（M4 §5.4）──────────────────────────────────────────────
  //
  // 写在这里而不是 /admin/*：那是"审核面"（一次性确认凭证、无 CSRF），本 API 面
  // 已有会话→主体 + CSRF + 幂等四元组 + 错误码映射，向导是商家自己的操作（BD §9）。

  /** 向导依赖；未配置 → 503（不伪造一个能用的向导）。 */
  function onboardingChannel(): NonNullable<MerchantManagementApiOptions["onboarding"]> {
    const channel = options.onboarding;
    if (channel === undefined) {
      throw new ManagementError("unavailable", "onboarding is not configured");
    }
    return channel;
  }

  /**
   * POST /onboarding/intents —— 打开/复用开通意图（§7.1：重复点击只返回同一条）。
   *
   * 幂等：同键同摘要回原结果、同键不同摘要 409（与其它写命令同口径）。
   */
  async function postOnboardingIntent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, [
      "intent_id",
      "version_digest",
      "idempotency_key",
      "new_generation",
    ]);
    authorizeOrThrow(auth.ctx, "onboarding:manage");
    const channel = onboardingChannel();
    const intentId = requireString(fields["intent_id"], "intent_id");
    const versionDigest = requireString(fields["version_digest"], "version_digest");
    const idempotencyKey = requireString(fields["idempotency_key"], "idempotency_key");
    const newGeneration = fields["new_generation"] === true;
    const requestDigest = managementRequestDigest({
      intent_id: intentId,
      version_digest: versionDigest,
      new_generation: newGeneration,
    });
    const probed = operations.probe({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType: "onboarding.open_intent",
      idempotencyKey,
      requestDigest,
    });
    if (probed.kind === "replay") {
      writeJson(res, 200, probed.receipt);
      return;
    }
    if (probed.kind === "conflict") {
      writeJson(res, 409, errorBody("conflict", "idempotency key was already used with a different request"));
      return;
    }
    const begun = operations.begin({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType: "onboarding.open_intent",
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
      const record = channel.store.openIntent({
        merchantId: auth.ctx.merchantId,
        intentId,
        versionDigest,
        idempotencyKey: `onb-open:${idempotencyKey}`,
        requestDigest,
        ...(newGeneration ? { newGeneration: true } : {}),
      });
      const receipt: OperationReceipt = {
        ...staticReceipt(begun.operationId, "onboarding.open_intent", "succeeded"),
        resource_ref: `onboarding:${record.recordId}`,
        completed_at: now().toISOString(),
      };
      operations.complete(begun.operationId, "succeeded", receipt);
      writeJson(res, 200, { ...receipt, record });
      return;
    } catch (err) {
      // 存储层拒绝（非法输入/冲突）→ 释放占位；未产生业务效果，可修正后原键重试。
      operations.release(begun.operationId);
      respondError(res, err);
      return;
    }
  }

  /**
   * POST /onboarding/{id}/advance —— 推进**一步**（§5.4）。
   *
   * 证据纪律（T007/T029）：请求体**只能给 `note`（留痕用）**，不能给权威证据。
   * 需要权威证据的步骤由服务端 `platformEvidence` 适配器去平台取回执；适配器未配置
   * 或取不到 → **不推进**（503 / 拒绝），绝不接受客户端自称的"查询回执"。
   */
  async function postOnboardingAdvance(
    req: IncomingMessage,
    res: ServerResponse,
    recordId: string,
  ): Promise<void> {
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, ["step", "expected_revision", "idempotency_key", "note"]);
    authorizeOrThrow(auth.ctx, "onboarding:manage");
    const channel = onboardingChannel();
    const stepId = requireString(fields["step"], "step");
    const expectedRevision = requireInteger(fields["expected_revision"], "expected_revision");
    const idempotencyKey = requireString(fields["idempotency_key"], "idempotency_key");
    const note = optionalString(fields["note"], "note");

    const record = channel.store.getRecord(recordId);
    if (record === undefined || record.merchantId !== auth.ctx.merchantId) {
      // 不区分"不存在"与"不归本商家"（防枚举）
      throw new ManagementError("not_found", `unknown onboarding record: ${recordId}`);
    }
    const definition = WIZARD_STEPS.find((step) => step.id === stepId);
    if (definition === undefined) {
      throw new ManagementError("invalid_input", `unknown wizard step: ${stepId}`);
    }

    const requestDigest = managementRequestDigest({ record_id: recordId, step: stepId, expected_revision: expectedRevision });
    const probed = operations.probe({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType: "onboarding.advance",
      idempotencyKey,
      requestDigest,
    });
    if (probed.kind === "replay") {
      writeJson(res, 200, probed.receipt);
      return;
    }
    if (probed.kind === "conflict") {
      writeJson(res, 409, errorBody("conflict", "idempotency key was already used with a different request"));
      return;
    }
    const begun = operations.begin({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType: "onboarding.advance",
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
      // 证据获取与准入判定排在**幂等探测之后**：同键重放必须先回原回执（UC20），
      // 不能被"适配器未配置/取不到回执"的 503 抢先——那是两条不同的语义。
      let evidence: Evidence | undefined;
      if (definition.requiresAuthoritativeEvidence) {
        const adapter = channel.platformEvidence;
        if (adapter === undefined) {
          operations.release(begun.operationId);
          throw new ManagementError(
            "tool_binding_unavailable",
            `step ${stepId} needs authoritative platform evidence; the platform adapter is not configured`,
          );
        }
        const obtained = await adapter({ stepId, recordId: record.recordId });
        if (requestsDisabledLocalImplementation(obtained)) {
          throw new ManagementError(
            "unavailable",
            `platform capability ${obtained.code || "cloud_service_unavailable"} is unavailable; local implementation fallback is disabled`,
          );
        }
        if (obtained?.kind === "platform_failure") {
          throw new ManagementError(
            "unavailable",
            `platform did not return an authoritative receipt (${obtained.code || "platform_failure"})`,
          );
        }
        if (obtained === undefined) {
          operations.release(begun.operationId);
          throw new ManagementError(
            "unavailable",
            `platform did not return an authoritative receipt for step ${stepId}`,
          );
        }
        evidence = obtained;
      } else if (note !== undefined) {
        // 非权威留痕（例如商家拒绝的原因）：记录，但不推进任何状态（§7.2）。
        channel.store.recordPendingEvidence(record.recordId, {
          kind: "text_claim",
          summary: note,
          observedAt: now().toISOString(),
        });
      }

      // 提交前准入判定（状态不对/证据不足都在写之前拒，避免半途改状态）。
      const verdict = checkStepSubmission(record, definition.id, evidence);
      if (!verdict.ok) {
        operations.release(begun.operationId);
        throw new ManagementError(
          verdict.code === "evidence_not_authoritative" ? "forbidden" : "conflict",
          verdict.reason,
        );
      }

      const advanced = channel.store.advance({
        recordId: record.recordId,
        expectedRevision,
        nextStatus: definition.advancesTo,
        step: definition.id,
        ...(evidence !== undefined ? { evidence } : {}),
      });
      const receipt: OperationReceipt = {
        ...staticReceipt(begun.operationId, "onboarding.advance", "succeeded"),
        resource_ref: `onboarding:${advanced.recordId}`,
        result_revision: advanced.revision,
        completed_at: now().toISOString(),
      };
      operations.complete(begun.operationId, "succeeded", receipt);
      writeJson(res, 200, { ...receipt, record: advanced });
      return;
    } catch (err) {
      // 状态/证据被存储层拒 → 未产生效果，释放占位。
      operations.release(begun.operationId);
      respondError(res, err);
      return;
    }
  }

  /** POST /onboarding/{id}/cancel —— 撤销开通意图（终态；不自动删已有云资源）。 */
  async function postOnboardingCancel(
    req: IncomingMessage,
    res: ServerResponse,
    recordId: string,
  ): Promise<void> {
    await onboardSimpleCommand(res, req, recordId, "onboarding.cancel", (store, record) =>
      store.cancel(record.recordId, record.revision),
    );
  }

  /** POST /onboarding/{id}/consent-refused —— T007：商家拒绝授权 = 保持等待。 */
  async function postOnboardingConsentRefused(
    req: IncomingMessage,
    res: ServerResponse,
    recordId: string,
  ): Promise<void> {
    await onboardSimpleCommand(res, req, recordId, "onboarding.consent_refused", (store, record, note) =>
      store.recordConsentRefused(record.recordId, record.revision, note !== undefined ? { note } : {}),
    );
  }

  /** cancel / consent-refused 共用的薄编排（同幂等口径，避免两份重复代码）。 */
  async function onboardSimpleCommand(
    res: ServerResponse,
    req: IncomingMessage,
    recordId: string,
    commandType: string,
    run: (
      store: OnboardingStore,
      record: { recordId: string; merchantId: string; revision: number },
      note: string | undefined,
    ) => unknown,
  ): Promise<void> {
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, ["expected_revision", "idempotency_key", "note"]);
    authorizeOrThrow(auth.ctx, "onboarding:manage");
    const channel = onboardingChannel();
    const expectedRevision = requireInteger(fields["expected_revision"], "expected_revision");
    const idempotencyKey = requireString(fields["idempotency_key"], "idempotency_key");
    const note = optionalString(fields["note"], "note");
    const record = channel.store.getRecord(recordId);
    if (record === undefined || record.merchantId !== auth.ctx.merchantId) {
      throw new ManagementError("not_found", `unknown onboarding record: ${recordId}`);
    }
    if (record.revision !== expectedRevision) {
      throw new ManagementError(
        "precondition_changed",
        `record is at revision ${record.revision}, expected ${expectedRevision}`,
      );
    }
    const requestDigest = managementRequestDigest({ record_id: recordId, expected_revision: expectedRevision });
    const probed = operations.probe({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType,
      idempotencyKey,
      requestDigest,
    });
    if (probed.kind === "replay") {
      writeJson(res, 200, probed.receipt);
      return;
    }
    if (probed.kind === "conflict") {
      writeJson(res, 409, errorBody("conflict", "idempotency key was already used with a different request"));
      return;
    }
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
      const updated = run(channel.store, record, note);
      const receipt: OperationReceipt = {
        ...staticReceipt(begun.operationId, commandType, "succeeded"),
        resource_ref: `onboarding:${record.recordId}`,
        completed_at: now().toISOString(),
      };
      operations.complete(begun.operationId, "succeeded", receipt);
      writeJson(res, 200, { ...receipt, record: updated });
      return;
    } catch (err) {
      operations.release(begun.operationId);
      respondError(res, err);
      return;
    }
  }

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

  // ── 商品导入（BD §10.1：校验预览 → 确认提交；全批成功或全批不变）────────

  /**
   * POST /products/import-drafts —— 整表严格校验（任何行错误 → 整表拒绝并报
   * 行号）+ 当前表 CAS（base_digest）+ 增/改/留/删预览；只存草稿，不动商品表。
   * 语义是**整表替换**：新表未包含的 SKU 提交后即移除（预览给出 removed 数）。
   */
  async function postProductsImportDraft(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, ["table", "base_digest", "idempotency_key"]);
    authorizeOrThrow(auth.ctx, "products:import");
    const importChannel = options.productsImport;
    if (importChannel === undefined) {
      throw new ManagementError("unavailable", "product import storage is not configured");
    }
    let table: CloudProductTable;
    try {
      table = parseProductTable(fields["table"], "request body");
    } catch (err) {
      if (err instanceof ProductTableError) {
        throw new ManagementError("invalid_input", err.message);
      }
      throw err;
    }
    if (table.merchant_id !== options.merchantId) {
      throw new ManagementError("forbidden", "product table merchant_id does not match this instance");
    }
    let base: { digest: string; records: CloudProductRecord[] };
    try {
      base = importChannel.currentTable();
    } catch (err) {
      if (err instanceof ProductTableError) {
        throw new ManagementError("unavailable", `current product table unavailable (${err.code})`);
      }
      throw err;
    }
    const baseDigest = optionalString(fields["base_digest"], "base_digest");
    if (baseDigest !== undefined && baseDigest !== base.digest) {
      throw new ManagementError("precondition_changed", "product table changed since preview");
    }
    const currentBySku = new Map(base.records.map((record) => [record.sku, record]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const record of table.products) {
      const previous = currentBySku.get(record.sku);
      if (previous === undefined) added += 1;
      else if (JSON.stringify(previous) === JSON.stringify(record)) unchanged += 1;
      else updated += 1;
    }
    const removedCount = base.records.filter(
      (record) => !table.products.some((item) => item.sku === record.sku),
    ).length;
    const digest = productTableDigest(table);
    const created = options.drafts.create({
      merchantId: auth.ctx.merchantId,
      kind: "products_import",
      payloadJson: JSON.stringify(table),
      payloadDigest: digest,
      ...(base.digest !== "" ? { baseDigest: base.digest } : {}),
    });
    writeJson(res, 200, {
      draft_id: created.draftId,
      digest,
      reused: created.reused,
      base_digest: base.digest === "" ? null : base.digest,
      preview: { rows_total: table.products.length, added, updated, unchanged, removed: removedCount },
    });
  }

  /** POST /products/import-drafts/{id}/commit —— 原子落盘；结果不可分辨时记 unknown。 */
  async function postProductsImportCommit(
    req: IncomingMessage,
    res: ServerResponse,
    draftId: string,
  ): Promise<void> {
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, ["expected_draft_digest", "idempotency_key"]);
    authorizeOrThrow(auth.ctx, "products:import");
    const importChannel = options.productsImport;
    if (importChannel === undefined) {
      throw new ManagementError("unavailable", "product import storage is not configured");
    }
    const draft = options.drafts.getPayload(auth.ctx.merchantId, draftId);
    if (draft === undefined) {
      throw new ManagementError("not_found", `unknown draft: ${draftId}`);
    }
    if (draft.kind !== "products_import") {
      throw new ManagementError("invalid_input", "draft is not a products import");
    }
    const expectedDigest = requireString(fields["expected_draft_digest"], "expected_draft_digest");
    if (expectedDigest !== draft.payload_digest) {
      throw new ManagementError("precondition_changed", "draft digest does not match");
    }
    let table: CloudProductTable;
    try {
      table = JSON.parse(draft.payload_json) as CloudProductTable;
    } catch {
      throw new ManagementError("invalid_input", "draft payload is corrupted");
    }
    const idempotencyKey = requireString(fields["idempotency_key"], "idempotency_key");
    const requestDigest = managementRequestDigest({
      draft_id: draftId,
      expected_draft_digest: expectedDigest,
    });
    // 幂等探测先于草稿状态检查：同键重放必须回原回执，不能被「已提交」挡住（UC20）。
    const probed = operations.probe({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType: "products.import_commit",
      idempotencyKey,
      requestDigest,
    });
    if (probed.kind === "replay") {
      writeJson(res, 200, probed.receipt);
      return;
    }
    if (probed.kind === "conflict") {
      writeJson(res, 409, errorBody("conflict", "idempotency key was already used with a different request"));
      return;
    }
    if (draft.status === "committed") {
      throw new ManagementError("conflict", "draft has already been committed");
    }
    const begun = operations.begin({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType: "products.import_commit",
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
      const written = importChannel.commit(table);
      const marked = options.drafts.markCommitted(auth.ctx.merchantId, draftId);
      if (!marked) {
        // 并发重复提交：文件已写入同一内容，占位释放即可（不产生第二份业务效果）。
        operations.release(begun.operationId);
        writeJson(res, 409, errorBody("conflict", "draft has already been committed"));
        return;
      }
      const receipt: OperationReceipt = {
        ...staticReceipt(begun.operationId, "products.import_commit", "succeeded"),
        resource_ref: `products-table:${written.digest}`,
        completed_at: now().toISOString(),
      };
      operations.complete(begun.operationId, "succeeded", receipt);
      writeJson(res, 200, receipt);
      return;
    } catch (err) {
      if (err instanceof ProductTableError) {
        // 落盘前的校验/租户失败：商品表未动 → 释放占位，可修正后原键重试。
        operations.release(begun.operationId);
        respondError(res, new ManagementError("invalid_input", err.message));
        return;
      }
      // 文件系统失败且无法证明「未生效」→ 记 unknown，先查 GET /products 对账。
      log(`[merchant-management] products.import_commit 执行异常：${err instanceof Error ? err.message : String(err)}\n`);
      const receipt = staticReceipt(begun.operationId, "products.import_commit", "unknown");
      operations.complete(begun.operationId, "unknown", receipt);
      respondError(res, new ManagementError("unavailable", `commit outcome unknown; query operation ${begun.operationId} and GET /products before retrying`));
    }
  }

  // ── 策略草稿（BD §7.4：敏感原文只进私有存储；API 只见摘要与版本）──────────

  /** POST /policy/drafts —— patch 原文入库；响应只含 draft_id 与摘要。 */
  async function postPolicyDraft(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, ["patch", "expected_policy_revision"]);
    authorizeOrThrow(auth.ctx, "policy:draft");
    const patch = fields["patch"];
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new ManagementError("invalid_input", "patch must be a JSON object");
    }
    const current = options.policy?.();
    const expectedRevision = fields["expected_policy_revision"];
    if (expectedRevision !== undefined) {
      const expected = requireInteger(expectedRevision, "expected_policy_revision");
      if (current === undefined || current.version !== expected) {
        throw new ManagementError("precondition_changed", "policy revision changed");
      }
    }
    const patchObject = patch as Record<string, unknown>;
    const digest = managementRequestDigest(patchObject);
    const created = options.drafts.create({
      merchantId: auth.ctx.merchantId,
      kind: "policy_override",
      payloadJson: JSON.stringify(patchObject),
      payloadDigest: digest,
      ...(current !== undefined ? { baseDigest: current.digest } : {}),
    });
    writeJson(res, 200, {
      draft_id: created.draftId,
      digest,
      reused: created.reused,
      base_digest: current?.digest ?? null,
    });
  }

  /** POST /policy/drafts/{id}/commit —— 应用策略补丁；回执只含版本与摘要（红线 6）。 */
  async function postPolicyCommit(
    req: IncomingMessage,
    res: ServerResponse,
    draftId: string,
  ): Promise<void> {
    const auth = requireActor(req);
    assertWriteGuards(req, auth.sessionId);
    const body = await readJsonBody(req);
    const fields = objectFields(body, ["expected_draft_digest", "idempotency_key"]);
    authorizeOrThrow(auth.ctx, "policy:draft");
    const apply = options.policyApply;
    if (apply === undefined) {
      throw new ManagementError("unavailable", "policy apply is not configured");
    }
    const draft = options.drafts.getPayload(auth.ctx.merchantId, draftId);
    if (draft === undefined) {
      throw new ManagementError("not_found", `unknown draft: ${draftId}`);
    }
    if (draft.kind !== "policy_override") {
      throw new ManagementError("invalid_input", "draft is not a policy override");
    }
    const expectedDigest = requireString(fields["expected_draft_digest"], "expected_draft_digest");
    if (expectedDigest !== draft.payload_digest) {
      throw new ManagementError("precondition_changed", "draft digest does not match");
    }
    const idempotencyKey = requireString(fields["idempotency_key"], "idempotency_key");
    const requestDigest = managementRequestDigest({
      draft_id: draftId,
      expected_draft_digest: expectedDigest,
    });
    // 幂等探测先于草稿状态检查（同 UC20：重放不被「已提交」挡住）。
    const probed = operations.probe({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType: "policy.commit",
      idempotencyKey,
      requestDigest,
    });
    if (probed.kind === "replay") {
      writeJson(res, 200, probed.receipt);
      return;
    }
    if (probed.kind === "conflict") {
      writeJson(res, 409, errorBody("conflict", "idempotency key was already used with a different request"));
      return;
    }
    if (draft.status === "committed") {
      throw new ManagementError("conflict", "draft has already been committed");
    }
    const begun = operations.begin({
      merchantId: auth.ctx.merchantId,
      actorId: auth.ctx.actorId,
      commandType: "policy.commit",
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
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(draft.payload_json) as Record<string, unknown>;
    } catch {
      throw new ManagementError("invalid_input", "draft payload is corrupted");
    }
    try {
      const applied = await apply(patch);
      options.drafts.markCommitted(auth.ctx.merchantId, draftId);
      const receipt: OperationReceipt = {
        ...staticReceipt(begun.operationId, "policy.commit", "succeeded"),
        resource_ref: `policy:v${applied.version}`,
        result_revision: applied.version,
        completed_at: now().toISOString(),
      };
      operations.complete(begun.operationId, "succeeded", receipt);
      writeJson(res, 200, receipt);
      return;
    } catch (err) {
      // apply 是「校验 + 原子写」：校验失败未生效 → 释放占位可修正重试
      // （错误消息来自 runtime 校验层，不含策略数值本身）。
      operations.release(begun.operationId);
      respondError(res, new ManagementError("invalid_input", err instanceof Error ? err.message : String(err)));
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
    rest === "/service/resume" ||
    rest === "/products/import-drafts" ||
    rest === "/policy/drafts" ||
    rest === "/onboarding"
  ) {
    return true;
  }
  return (
    /^\/approvals\/[^/]+(\/approve|\/reject)?$/.test(rest) ||
    /^\/operations\/[^/]+$/.test(rest) ||
    /^\/products\/import-drafts\/[^/]+\/commit$/.test(rest) ||
    /^\/policy\/drafts\/[^/]+\/commit$/.test(rest) ||
    /^\/onboarding\/([^/]+)\/(advance|cancel|consent-refused)$/.test(rest)
  );
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

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagementError("invalid_input", `${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function sameAuthorizationGeneration(
  frozen: unknown,
  current: Readonly<Record<string, unknown>>,
): boolean {
  if (frozen === null || typeof frozen !== "object" || Array.isArray(frozen)) return false;
  const value = frozen as Record<string, unknown>;
  return (
    value["actor_id"] === current["actor_id"] &&
    value["actor_role"] === current["actor_role"] &&
    value["action"] === current["action"] &&
    value["authorization_generation"] === current["authorization_generation"]
  );
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

function requireDecision(value: unknown): "approve" | "reject" {
  if (value !== "approve" && value !== "reject") {
    throw new ManagementError("invalid_input", "decision must be approve or reject");
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

function writeWorkbenchProblem(
  res: ServerResponse,
  code: WorkbenchProblemCode,
  requestId: string,
  title: string,
  detail: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  const body = createWorkbenchProblem(code, {
    title,
    detail,
    requestId,
    ...(details !== undefined ? { details } : {}),
  });
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(body.status, {
    "content-type": "application/problem+json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-request-id": requestId,
  });
  res.end(JSON.stringify(body));
}

function respondWorkbenchError(res: ServerResponse, error: unknown, requestId: string): void {
  if (error instanceof MerchantGrantError) {
    const code: WorkbenchProblemCode =
      error.code === "not_found"
        ? "RESOURCE_NOT_FOUND"
        : error.code === "invalid_input"
          ? "VALIDATION_ERROR"
          : "PERMISSION_REVOKED";
    writeWorkbenchProblem(res, code, requestId, "授权未通过", error.message);
    return;
  }
  if (error instanceof MerchantFeedError) {
    const code: WorkbenchProblemCode =
      error.code === "not_found"
        ? "RESOURCE_NOT_FOUND"
        : error.code === "version_conflict"
          ? "VERSION_CONFLICT"
          : "VALIDATION_ERROR";
    writeWorkbenchProblem(res, code, requestId, "广播请求未完成", error.message);
    return;
  }
  if (error instanceof WorkbenchConfirmationError) {
    const mapping: Record<WorkbenchConfirmationError["code"], WorkbenchProblemCode> = {
      invalid_registration: "CONFIRMATION_INVALID",
      confirmation_not_found: "RESOURCE_NOT_FOUND",
      confirmation_expired: "CONFIRMATION_EXPIRED",
      confirmation_consumed: "CONFIRMATION_INVALID",
      confirmation_binding_mismatch: "CONFIRMATION_INVALID",
      credential_unavailable: "CONFIRMATION_CHANNEL_UNAVAILABLE",
      assertion_invalid: "CONFIRMATION_INVALID",
    };
    writeWorkbenchProblem(res, mapping[error.code], requestId, "可信确认未完成", error.message);
    return;
  }
  if (error instanceof ActorContextError) {
    if (error.code === "expired_context") {
      writeWorkbenchProblem(
        res,
        "UNAUTHENTICATED",
        requestId,
        "需要重新登录",
        "管理会话或主体上下文已经过期。",
      );
      return;
    }
    writeWorkbenchProblem(
      res,
      "INTERNAL_ERROR",
      requestId,
      "主体校验失败",
      "主体上下文完整性校验失败。",
    );
    return;
  }
  if (error instanceof ManagementError) {
    const mapping: Readonly<Record<string, WorkbenchProblemCode>> = {
      unauthorized: "UNAUTHENTICATED",
      forbidden: "PERMISSION_REVOKED",
      not_found: "RESOURCE_NOT_FOUND",
      conflict: "VERSION_CONFLICT",
      precondition_changed: "VERSION_CONFLICT",
      invalid_input: "VALIDATION_ERROR",
      rate_limited: "RATE_LIMITED",
      unavailable: "DEPENDENCY_UNAVAILABLE",
      tool_binding_unavailable: "DEPENDENCY_UNAVAILABLE",
      update_required: "VERSION_CONFLICT",
    };
    writeWorkbenchProblem(
      res,
      mapping[error.code] ?? "INTERNAL_ERROR",
      requestId,
      "请求未完成",
      error.message,
      { support_id: error.supportId },
    );
    return;
  }
  process.stderr.write(
    `[merchant-management] Workbench 未预期异常：${error instanceof Error ? error.message : String(error)}\n`,
  );
  writeWorkbenchProblem(
    res,
    "INTERNAL_ERROR",
    requestId,
    "内部错误",
    "请求未完成，请使用请求编号联系支持。",
  );
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
