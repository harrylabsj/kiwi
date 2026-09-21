/** Public read-only Merchant Feed HTTP adapter (merchant-feed/1). */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { MerchantFeedError, type MerchantFeedStore } from "../merchant/feed-store.js";
import { createWorkbenchProblem, type WorkbenchProblemCode } from "./merchant-management/problem.js";

export function createMerchantFeedApiHandler(options: {
  merchantId: string;
  store: MerchantFeedStore;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(req, res).catch(() =>
      writeProblem(res, "INTERNAL_ERROR", requestId(), "内部错误", "Feed 请求未完成。"),
    );
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = requestId();
    if (req.headers.authorization !== undefined || req.headers.cookie !== undefined) {
      writeProblem(
        res,
        "VALIDATION_ERROR",
        id,
        "公开 Feed 不接受凭据",
        "请移除 Authorization/Cookie；认证响应不得进入公开缓存。",
      );
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      writeProblem(res, "VALIDATION_ERROR", id, "请求方法不可用", "公开 Feed 只接受 GET/HEAD。");
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://merchant-feed.internal");
    } catch {
      writeProblem(res, "VALIDATION_ERROR", id, "请求地址无效", "请求地址无法解析。");
      return;
    }
    try {
      if (url.pathname === "/public/v1/updates") {
        const limit = parseNonNegativeInteger(url.searchParams.get("limit"), 50);
        const result = options.store.read(options.merchantId, {
          ...(url.searchParams.get("cursor") !== null
            ? { cursor: url.searchParams.get("cursor") ?? undefined }
            : {}),
          limit,
          ...(singleHeader(req, "if-none-match") !== undefined
            ? { ifNoneMatch: singleHeader(req, "if-none-match") }
            : {}),
        });
        if (result.kind === "not_modified") {
          res.writeHead(304, {
            etag: result.etag,
            "cache-control": "public, max-age=0, must-revalidate",
            "x-request-id": id,
          });
          res.end();
          return;
        }
        writeJson(res, 200, result, id, {
          etag: result.etag,
          "cache-control": "public, max-age=0, must-revalidate",
        });
        return;
      }
      if (url.pathname === "/public/v1/updates/snapshot") {
        writeJson(res, 200, options.store.createSnapshot(options.merchantId), id, {
          "cache-control": "public, max-age=0, must-revalidate",
        });
        return;
      }
      const snapshot = /^\/public\/v1\/updates\/snapshots\/([^/]+)$/.exec(url.pathname);
      if (snapshot !== null) {
        const offset = parseNonNegativeInteger(url.searchParams.get("offset"), 0);
        const limit = parseNonNegativeInteger(url.searchParams.get("limit"), 50);
        writeJson(
          res,
          200,
          options.store.readSnapshotPage(
            options.merchantId,
            decodeURIComponent(snapshot[1] ?? ""),
            offset,
            limit,
          ),
          id,
          { "cache-control": "public, max-age=0, must-revalidate" },
        );
        return;
      }
      writeProblem(res, "RESOURCE_NOT_FOUND", id, "资源不存在", "公开 Feed 路由不存在。");
    } catch (error) {
      respondFeedError(res, id, error);
    }
  }
}

function respondFeedError(res: ServerResponse, id: string, error: unknown): void {
  if (!(error instanceof MerchantFeedError)) {
    writeProblem(res, "INTERNAL_ERROR", id, "内部错误", "Feed 请求未完成。");
    return;
  }
  const mapping: Record<MerchantFeedError["code"], WorkbenchProblemCode> = {
    validation_error: "VALIDATION_ERROR",
    not_found: "RESOURCE_NOT_FOUND",
    version_conflict: "VERSION_CONFLICT",
    feed_cursor_invalid: "FEED_CURSOR_INVALID",
    feed_reset_required: "FEED_RESET_REQUIRED",
    snapshot_expired: "SNAPSHOT_EXPIRED",
  };
  writeProblem(res, mapping[error.code], id, "Feed 请求未完成", error.message);
}

function parseNonNegativeInteger(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new MerchantFeedError("validation_error", "pagination value must be a non-negative integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MerchantFeedError("validation_error", "pagination value is outside the safe integer range");
  }
  return parsed;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  id: string,
  headers: Record<string, string>,
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": id,
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function writeProblem(
  res: ServerResponse,
  code: WorkbenchProblemCode,
  id: string,
  title: string,
  detail: string,
): void {
  if (res.headersSent) return;
  const problem = createWorkbenchProblem(code, { title, detail, requestId: id });
  res.writeHead(problem.status, {
    "content-type": "application/problem+json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": id,
  });
  res.end(JSON.stringify(problem));
}
