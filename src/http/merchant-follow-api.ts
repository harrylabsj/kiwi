/** Authenticated Buyer follow API backed by MerchantFollowStore (merchant-follow/1). */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  followRequestDigest,
  MerchantFollowError,
  type MerchantFollowStore,
} from "../merchant/follow-store.js";
import {
  createWorkbenchProblem,
  type WorkbenchProblemCode,
} from "./merchant-management/problem.js";

const MAX_BODY_BYTES = 16 * 1024;

export interface VerifiedBuyerPrincipal {
  merchantId: string;
  buyerPrincipalId: string;
}

export interface MerchantFollowApiOptions {
  merchantId: string;
  store: MerchantFollowStore;
  /** Must verify a credential/delegation; never derive identity from request JSON. */
  resolveBuyer: (
    request: IncomingMessage,
    body?: Buffer,
  ) => VerifiedBuyerPrincipal | undefined | Promise<VerifiedBuyerPrincipal | undefined>;
}

export function createMerchantFollowApiHandler(
  options: MerchantFollowApiOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(req, res).catch(() => {
      writeProblem(
        res,
        "INTERNAL_ERROR",
        requestId(),
        "内部错误",
        "请求未完成。请使用请求编号联系支持。",
      );
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = requestId();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://merchant-follow.internal");
    } catch {
      writeProblem(res, "VALIDATION_ERROR", id, "请求地址无效", "请求地址无法解析。");
      return;
    }
    if (url.pathname !== "/buyer/v1/follow") {
      writeProblem(res, "RESOURCE_NOT_FOUND", id, "资源不存在", "Buyer follow 路由不存在。");
      return;
    }
    let rawBody: Buffer | undefined;
    if (req.method === "PUT") {
      try {
        rawBody = await readBody(req);
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
    }
    const principal = await options.resolveBuyer(req, rawBody);
    if (principal === undefined) {
      writeProblem(res, "UNAUTHENTICATED", id, "需要认证", "需要可验证的 Buyer 身份或委托。");
      return;
    }
    if (principal.merchantId !== options.merchantId) {
      // 不披露另一个商家实例是否存在。
      writeProblem(res, "RESOURCE_NOT_FOUND", id, "资源不存在", "Buyer follow 资源不存在。");
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const result = options.store.read(options.merchantId, principal.buyerPrincipalId);
      writeJson(res, 200, result, id, {
        etag: followEtag(result.follow.epoch, result.follow.revision),
      });
      return;
    }
    if (req.method !== "PUT" && req.method !== "DELETE") {
      writeProblem(
        res,
        "VALIDATION_ERROR",
        id,
        "请求方法不可用",
        "该路由只接受 GET、PUT、DELETE。",
        {
          allow: "GET, PUT, DELETE",
        },
      );
      return;
    }

    const current = options.store.read(options.merchantId, principal.buyerPrincipalId).follow;
    const ifMatch = singleHeader(req, "if-match");
    if (ifMatch === undefined) {
      writeProblem(res, "PRECONDITION_REQUIRED", id, "缺少前置版本", "写请求必须提供 If-Match。", {
        current_etag: followEtag(current.epoch, current.revision),
      });
      return;
    }
    if (ifMatch !== followEtag(current.epoch, current.revision)) {
      writeProblem(res, "PRECONDITION_FAILED", id, "关系版本已变化", "请刷新关系状态后重新确认。", {
        current_etag: followEtag(current.epoch, current.revision),
      });
      return;
    }
    const key = singleHeader(req, "idempotency-key");
    const context = singleHeader(req, "x-mutation-context");
    if (key === undefined || context === undefined) {
      writeProblem(
        res,
        "VALIDATION_ERROR",
        id,
        "缺少写入凭据",
        "Idempotency-Key 与 X-Mutation-Context 均为必填。",
      );
      return;
    }
    let body: Record<string, unknown> = {};
    if (req.method === "PUT") {
      try {
        body = readObject(rawBody ?? Buffer.alloc(0));
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
      const unexpected = Object.keys(body).filter(
        (field) => !["category", "consent_version"].includes(field),
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
    }
    const action = req.method === "PUT" ? "follow" : "unfollow";
    try {
      const result = options.store.mutate({
        merchantId: options.merchantId,
        buyerPrincipalId: principal.buyerPrincipalId,
        action,
        expectedRevision: current.revision,
        mutationContext: context,
        idempotencyKey: key,
        requestDigest: followRequestDigest({ action, if_match: ifMatch, body }),
        ...(typeof body["consent_version"] === "string"
          ? { consentVersion: body["consent_version"] }
          : {}),
        ...(typeof body["category"] === "string" ? { category: body["category"] } : {}),
      });
      writeJson(res, 200, result, id, {
        etag: followEtag(result.follow.epoch, result.follow.revision),
      });
    } catch (error) {
      respondStoreError(res, id, error);
    }
  }
}

export function followEtag(epoch: number, revision: number): string {
  return `"follow-${epoch}-${revision}"`;
}

function respondStoreError(res: ServerResponse, id: string, error: unknown): void {
  if (!(error instanceof MerchantFollowError)) {
    writeProblem(res, "INTERNAL_ERROR", id, "内部错误", "关注关系未更新。");
    return;
  }
  const mapping: Record<MerchantFollowError["code"], WorkbenchProblemCode> = {
    invalid_input: "VALIDATION_ERROR",
    precondition_failed: "PRECONDITION_FAILED",
    idempotency_key_reused: "IDEMPOTENCY_KEY_REUSED",
    idempotency_window_expired: "IDEMPOTENCY_WINDOW_EXPIRED",
    mutation_context_invalid: "PRECONDITION_FAILED",
  };
  writeProblem(res, mapping[error.code], id, "关注关系未更新", error.message);
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
  if (body.length === 0) return {};
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求正文必须是 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function requestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  id: string,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-request-id": id,
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function writeProblem(
  res: ServerResponse,
  code: WorkbenchProblemCode,
  id: string,
  title: string,
  detail: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  if (res.headersSent) return;
  const problem = createWorkbenchProblem(code, {
    title,
    detail,
    requestId: id,
    ...(details !== undefined ? { details } : {}),
  });
  res.writeHead(problem.status, {
    "content-type": "application/problem+json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-request-id": id,
  });
  res.end(JSON.stringify(problem));
}
