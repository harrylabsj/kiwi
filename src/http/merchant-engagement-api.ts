/** Verified Buyer receipt/presentation/click facts; HTTP success alone records nothing. */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { VerifiedBuyerPrincipal } from "./merchant-follow-api.js";
import {
  ENGAGEMENT_EVENT_TYPES,
  MerchantEngagementError,
  type EngagementEventType,
  type MerchantEngagementStore,
} from "../merchant/engagement-store.js";
import {
  createWorkbenchProblem,
  type WorkbenchProblemCode,
} from "./merchant-management/problem.js";

const MAX_BODY_BYTES = 16 * 1024;

export function createMerchantEngagementApiHandler(options: {
  merchantId: string;
  store: MerchantEngagementStore;
  broadcastExists: (broadcastId: string) => boolean;
  resolveBuyer: (
    request: IncomingMessage,
    body: Buffer,
  ) => VerifiedBuyerPrincipal | undefined | Promise<VerifiedBuyerPrincipal | undefined>;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(req, res).catch(() =>
      writeProblem(res, "INTERNAL_ERROR", requestId(), "内部错误", "广播反馈未记录。"),
    );
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = requestId();
    const url = new URL(req.url ?? "/", "http://merchant-engagement.internal");
    if (url.pathname !== "/buyer/v1/broadcast-events") {
      writeProblem(res, "RESOURCE_NOT_FOUND", id, "资源不存在", "Buyer 反馈路由不存在。");
      return;
    }
    if (req.method !== "POST") {
      writeProblem(res, "VALIDATION_ERROR", id, "请求方法不可用", "该路由只接受 POST。", {
        allow: "POST",
      });
      return;
    }
    let raw: Buffer;
    let body: Record<string, unknown>;
    try {
      raw = await readBody(req);
      body = readObject(raw);
    } catch (error) {
      writeProblem(
        res,
        "VALIDATION_ERROR",
        id,
        "请求正文无效",
        error instanceof Error ? error.message : "请求正文无效。",
      );
      return;
    }
    const principal = await options.resolveBuyer(req, raw);
    if (principal === undefined) {
      writeProblem(res, "UNAUTHENTICATED", id, "需要认证", "需要可验证的 Buyer 身份。");
      return;
    }
    if (principal.merchantId !== options.merchantId) {
      writeProblem(res, "RESOURCE_NOT_FOUND", id, "资源不存在", "广播反馈资源不存在。");
      return;
    }
    const unexpected = Object.keys(body).filter(
      (field) => !["broadcast_id", "event_type", "occurred_at"].includes(field),
    );
    if (unexpected.length > 0) {
      writeProblem(
        res,
        "VALIDATION_ERROR",
        id,
        "存在未知字段",
        `未知字段：${unexpected.join(", ")}`,
      );
      return;
    }
    const broadcastId = requireString(body["broadcast_id"], "broadcast_id");
    const eventType = body["event_type"];
    if (!ENGAGEMENT_EVENT_TYPES.includes(eventType as EngagementEventType)) {
      writeProblem(
        res,
        "VALIDATION_ERROR",
        id,
        "反馈类型无效",
        "event_type 必须是 received、presented 或 clicked。",
      );
      return;
    }
    if (!options.broadcastExists(broadcastId)) {
      writeProblem(res, "RESOURCE_NOT_FOUND", id, "广播不存在", "无法关联该广播反馈。");
      return;
    }
    const key = singleHeader(req, "idempotency-key");
    if (key === undefined || key.trim() === "") {
      writeProblem(res, "VALIDATION_ERROR", id, "缺少幂等键", "Idempotency-Key 为必填。");
      return;
    }
    try {
      const result = options.store.record({
        merchantId: options.merchantId,
        buyerPrincipalId: principal.buyerPrincipalId,
        broadcastId,
        eventType: eventType as EngagementEventType,
        idempotencyKey: key,
        occurredAt: requireString(body["occurred_at"], "occurred_at"),
      });
      writeJson(res, result.replayed ? 200 : 201, result, id);
    } catch (error) {
      if (!(error instanceof MerchantEngagementError)) throw error;
      const code: WorkbenchProblemCode =
        error.code === "conflict"
          ? "IDEMPOTENCY_KEY_REUSED"
          : error.code === "precondition_failed"
            ? "PRECONDITION_FAILED"
            : "VALIDATION_ERROR";
      writeProblem(res, code, id, "广播反馈未记录", error.message);
    }
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求正文超过 16 KiB 限制。");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function readObject(body: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求正文必须是 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} 必须是非空字符串。`);
  return value;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

function writeProblem(
  res: ServerResponse,
  code: WorkbenchProblemCode,
  requestIdValue: string,
  title: string,
  detail: string,
  details?: Record<string, unknown>,
): void {
  const body = createWorkbenchProblem(code, {
    requestId: requestIdValue,
    title,
    detail,
    ...(details === undefined ? {} : { details }),
  });
  res.writeHead(body.status, {
    "content-type": "application/problem+json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestIdValue,
  });
  res.end(JSON.stringify(body));
}

function writeJson(res: ServerResponse, status: number, body: unknown, id: string): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": id,
  });
  res.end(JSON.stringify(body));
}
