/**
 * Workbench v0.1.1 /merchant/api/v1 错误契约（RFC 9457）。
 *
 * 仅供新 v1 管理 API 使用；既有 A2A、MCP 和 legacy /merchant/api/* 保持各自已锁定
 * 的错误外壳。`retryable=true` 只表示服务端已证明没有业务效果，可以按同一逻辑操作
 * 重试；结果未知必须查询原 operation。
 */

export const RECOVERY_ACTIONS = [
  "none",
  "reauthenticate",
  "refresh_resource",
  "confirm",
  "query_operation",
  "retry_same_operation",
  "resync_feed",
  "open_support",
] as const;

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

const DEFINITIONS = {
  VALIDATION_ERROR: [422, false, "refresh_resource"],
  UNAUTHENTICATED: [401, false, "reauthenticate"],
  PERMISSION_REVOKED: [403, false, "open_support"],
  RESOURCE_NOT_FOUND: [404, false, "none"],
  VERSION_CONFLICT: [409, false, "refresh_resource"],
  PRECONDITION_FAILED: [412, false, "refresh_resource"],
  PRECONDITION_REQUIRED: [428, false, "refresh_resource"],
  APPROVAL_ALREADY_DECIDED: [409, false, "refresh_resource"],
  CANDIDATE_EXPIRED: [410, false, "refresh_resource"],
  CONFIRMATION_REQUIRED: [403, false, "confirm"],
  CONFIRMATION_EXPIRED: [410, false, "confirm"],
  CONFIRMATION_INVALID: [403, false, "confirm"],
  CONFIRMATION_CHANNEL_UNAVAILABLE: [503, false, "open_support"],
  IDEMPOTENCY_KEY_REUSED: [409, false, "refresh_resource"],
  IDEMPOTENCY_WINDOW_EXPIRED: [409, false, "refresh_resource"],
  OPERATION_RESULT_UNKNOWN: [504, false, "query_operation"],
  DEPENDENCY_UNAVAILABLE: [503, true, "retry_same_operation"],
  CATALOG_UNAVAILABLE: [503, true, "retry_same_operation"],
  PRODUCT_SOURCE_UNAVAILABLE: [503, true, "retry_same_operation"],
  LLM_UNAVAILABLE: [503, true, "retry_same_operation"],
  BROADCAST_PUBLISH_FAILED: [503, false, "query_operation"],
  RATE_LIMITED: [429, true, "retry_same_operation"],
  RUNTIME_PAUSED: [409, false, "none"],
  RUNTIME_RECOVERING: [503, false, "open_support"],
  SERVICE_AUTH_REVOKED: [403, false, "open_support"],
  FEED_RESET_REQUIRED: [409, false, "resync_feed"],
  FEED_CURSOR_INVALID: [400, false, "resync_feed"],
  SNAPSHOT_EXPIRED: [410, false, "resync_feed"],
  MONEY_PRECISION_UNRECOVERABLE: [422, false, "refresh_resource"],
  MONEY_RANGE_EXCEEDED: [422, false, "refresh_resource"],
  RETENTION_RESTRICTED: [409, false, "open_support"],
  STORAGE_CAPACITY_EXCEEDED: [507, false, "open_support"],
  COMPLIANCE_REVIEW_REQUIRED: [409, false, "open_support"],
  INTERNAL_ERROR: [500, false, "open_support"],
} as const satisfies Record<string, readonly [number, boolean, RecoveryAction]>;

export type WorkbenchProblemCode = keyof typeof DEFINITIONS;

export interface WorkbenchProblem {
  type: `urn:kiwi:problem:${string}`;
  title: string;
  status: number;
  detail: string;
  code: WorkbenchProblemCode;
  request_id: string;
  operation_id?: string;
  retryable: boolean;
  recovery_action: RecoveryAction;
  details?: Readonly<Record<string, unknown>>;
}

export interface ProblemDefinition {
  code: WorkbenchProblemCode;
  type: `urn:kiwi:problem:${string}`;
  status: number;
  retryable: boolean;
  recoveryAction: RecoveryAction;
}

const SENSITIVE_DETAIL_KEYS = new Set([
  "authorization",
  "token",
  "password",
  "secret",
  "api_key",
  "bottom_price",
  "cost",
]);

export const WORKBENCH_PROBLEM_DEFINITIONS: Readonly<Record<WorkbenchProblemCode, ProblemDefinition>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(DEFINITIONS).map(([code, [status, retryable, recoveryAction]]) => [
        code,
        {
          code,
          type: `urn:kiwi:problem:${code.toLowerCase().replaceAll("_", "-")}`,
          status,
          retryable,
          recoveryAction,
        },
      ]),
    ) as unknown as Record<WorkbenchProblemCode, ProblemDefinition>,
  );

export function createWorkbenchProblem(
  code: WorkbenchProblemCode,
  input: {
    title: string;
    detail: string;
    requestId: string;
    operationId?: string;
    details?: Readonly<Record<string, unknown>>;
  },
): WorkbenchProblem {
  const definition = WORKBENCH_PROBLEM_DEFINITIONS[code];
  const title = requireText(input.title, "title", 160);
  const detail = requireText(input.detail, "detail", 1000);
  const requestId = requireText(input.requestId, "requestId", 128);
  if (code === "OPERATION_RESULT_UNKNOWN" && input.operationId === undefined) {
    throw new Error("OPERATION_RESULT_UNKNOWN requires operationId");
  }
  if (input.details !== undefined) assertSafeDetails(input.details);
  return {
    type: definition.type,
    title,
    status: definition.status,
    detail,
    code,
    request_id: requestId,
    ...(input.operationId !== undefined
      ? { operation_id: requireText(input.operationId, "operationId", 128) }
      : {}),
    retryable: definition.retryable,
    recovery_action: definition.recoveryAction,
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
}

function assertSafeDetails(details: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(details)) {
    if (SENSITIVE_DETAIL_KEYS.has(key.toLowerCase())) {
      throw new Error(`problem details contains forbidden sensitive key: ${key}`);
    }
  }
}

function requireText(value: string, field: string, maxLength: number): string {
  const text = String(value ?? "").trim();
  if (text.length === 0 || text.length > maxLength) {
    throw new Error(`${field} must contain 1..${maxLength} characters`);
  }
  return text;
}
