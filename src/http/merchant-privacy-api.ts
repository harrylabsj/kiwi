/** Verified Buyer privacy-request intake and status lookup. */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { VerifiedBuyerPrincipal } from "./merchant-follow-api.js";
import {
  WorkbenchRetentionError,
  type WorkbenchRetentionStore,
} from "../privacy/workbench-retention.js";
import {
  createWorkbenchProblem,
  type WorkbenchProblemCode,
} from "./merchant-management/problem.js";

export function createMerchantPrivacyApiHandler(options: {
  merchantId: string;
  store: WorkbenchRetentionStore;
  resolveBuyer: (
    request: IncomingMessage,
    body?: Buffer,
  ) => VerifiedBuyerPrincipal | undefined | Promise<VerifiedBuyerPrincipal | undefined>;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(req, res).catch(() =>
      writeProblem(res, "INTERNAL_ERROR", requestId(), "内部错误", "隐私请求未处理。"),
    );
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = requestId();
    const url = new URL(req.url ?? "/", "http://merchant-privacy.internal");
    const detail = /^\/buyer\/v1\/privacy-requests\/([^/]+)$/u.exec(url.pathname);
    const collection = url.pathname === "/buyer/v1/privacy-requests";
    if (!collection && detail === null) {
      writeProblem(res, "RESOURCE_NOT_FOUND", id, "资源不存在", "隐私请求路由不存在。");
      return;
    }
    const principal = await options.resolveBuyer(req);
    if (principal === undefined) {
      writeProblem(res, "UNAUTHENTICATED", id, "需要认证", "需要可验证的 Buyer 身份。");
      return;
    }
    if (principal.merchantId !== options.merchantId) {
      writeProblem(res, "RESOURCE_NOT_FOUND", id, "资源不存在", "隐私请求资源不存在。");
      return;
    }
    if (collection && req.method === "POST") {
      try {
        const record = options.store.receiveBuyerDeletionRequest({
          merchantId: options.merchantId,
          buyerPrincipalId: principal.buyerPrincipalId,
        });
        writeJson(res, 202, projection(record), id);
      } catch (error) {
        respondStoreError(res, id, error);
      }
      return;
    }
    if (detail !== null && (req.method === "GET" || req.method === "HEAD")) {
      const request = options.store.getRequest(
        decodeURIComponent(detail[1] ?? ""),
        options.merchantId,
      );
      if (request === undefined || request.buyerPrincipalId !== principal.buyerPrincipalId) {
        writeProblem(res, "RESOURCE_NOT_FOUND", id, "资源不存在", "隐私请求不存在。");
        return;
      }
      writeJson(res, 200, projection(request), id);
      return;
    }
    writeProblem(
      res,
      "VALIDATION_ERROR",
      id,
      "请求方法不可用",
      "集合只接受 POST，详情只接受 GET。",
    );
  }
}

function projection(record: import("../privacy/workbench-retention.js").PrivacyRequestRecord) {
  return {
    request_id: record.requestId,
    status: record.status,
    consent_generation: record.consentGeneration,
    received_at: record.receivedAt,
    updated_at: record.updatedAt,
  };
}

function respondStoreError(res: ServerResponse, id: string, error: unknown): void {
  if (!(error instanceof WorkbenchRetentionError)) throw error;
  const code: WorkbenchProblemCode =
    error.code === "POLICY_INVALID"
      ? "COMPLIANCE_REVIEW_REQUIRED"
      : error.code === "REQUEST_NOT_FOUND"
        ? "RESOURCE_NOT_FOUND"
        : "VERSION_CONFLICT";
  writeProblem(res, code, id, "隐私请求未处理", error.message);
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
): void {
  const body = createWorkbenchProblem(code, { requestId: requestIdValue, title, detail });
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
