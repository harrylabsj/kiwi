/** RFC 9457 client-side consumer for the Workbench v1 management API. */

export type ClientRecoveryAction =
  | "none"
  | "reauthenticate"
  | "refresh_resource"
  | "confirm"
  | "query_operation"
  | "retry_same_operation"
  | "resync_feed"
  | "open_support"
  | "unknown";

export interface WorkbenchClientProblem {
  type?: string;
  title?: string;
  status: number;
  detail: string;
  code: string;
  requestId?: string;
  operationId?: string;
  retryable: boolean;
  recoveryAction: ClientRecoveryAction;
  details?: Record<string, unknown>;
}

const ACTIONS = new Set<ClientRecoveryAction>([
  "none",
  "reauthenticate",
  "refresh_resource",
  "confirm",
  "query_operation",
  "retry_same_operation",
  "resync_feed",
  "open_support",
]);

/**
 * Parse only Problem Details responses. Malformed or non-problem responses
 * return undefined so callers can use a transport-level fallback safely.
 */
export async function parseWorkbenchProblem(
  response: Pick<Response, "status" | "headers" | "json">,
): Promise<WorkbenchClientProblem | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/problem+json")) return undefined;
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const code = text(body.code);
  const detail = text(body.detail);
  if (code === "" || detail === "") return undefined;
  const action = text(body.recovery_action);
  return {
    ...(typeof body.type === "string" ? { type: body.type } : {}),
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    status: response.status,
    detail,
    code,
    ...(typeof body.request_id === "string" ? { requestId: body.request_id } : {}),
    ...(typeof body.operation_id === "string" ? { operationId: body.operation_id } : {}),
    retryable: body.retryable === true,
    recoveryAction: ACTIONS.has(action as ClientRecoveryAction)
      ? (action as ClientRecoveryAction)
      : "unknown",
    ...(body.details !== null && typeof body.details === "object" && !Array.isArray(body.details)
      ? { details: body.details as Record<string, unknown> }
      : {}),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
