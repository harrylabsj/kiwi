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
 * 工作台页面写门令牌自愈（2026-11-01 商户导入卡死回归）。
 *
 * CSRF 令牌 = HMAC(sessionId, 进程级密钥)，运行时重启或重新登录后页面里的旧
 * 令牌即失效；页面只在加载时取一次。这里验证：写请求遇到该 403 会先重取
 * /merchant/api/session 再用新令牌重试**一次**，且其他 403 不重试。
 */
import { describe, expect, it } from "vitest";
import { createContext, runInContext } from "node:vm";

import { renderMerchantManagementPage } from "../src/http/merchant-management/page.js";

type Element = {
  value: string;
  innerHTML: string;
  textContent: string;
  className: string;
  style: { display: string };
};

function pageScript(): string {
  const html = renderMerchantManagementPage({ productAuthority: "file" });
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)]
    .map((match) => match[1] ?? "")
    .join("\n");
}

function csrfProblem(detail: string): Response {
  return new Response(
    JSON.stringify({
      type: "urn:kiwi:problem:permission-revoked",
      title: "请求未完成",
      status: 403,
      detail,
      code: "PERMISSION_REVOKED",
      request_id: "req_test",
      retryable: false,
      recovery_action: "open_support",
    }),
    { status: 403, headers: { "content-type": "application/problem+json; charset=utf-8" } },
  );
}

function createPageContext(
  elements: Record<string, Element>,
  fetchImpl: (path: string, init?: { headers?: Record<string, string>; body?: unknown }) => Promise<Response>,
) {
  return createContext({
    URL,
    Date,
    Math,
    Response,
    fetch: fetchImpl,
    setTimeout,
    document: {
      querySelectorAll: () => [],
      getElementById: (id: string) =>
        (elements[id] ??= { value: "", innerHTML: "", textContent: "", className: "", style: { display: "" } }),
    },
  });
}

async function loadPage(context: ReturnType<typeof createContext>): Promise<void> {
  await runInContext(pageScript(), context);
  // 等页面加载时的 /merchant/api/session 调用落定。
  await tick();
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 页面里的 submitImportTable 不返回 Promise，只能等它的异步链落定。 */
async function eventually(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("merchant workbench CSRF recovery", () => {
  it("refreshes the token and retries a write rejected by a stale CSRF token", async () => {
    const elements: Record<string, Element> = {};
    const sentTokens: string[] = [];
    let sessionCalls = 0;
    const context = createPageContext(elements, async (path, init) => {
      if (path === "/merchant/api/session") {
        sessionCalls += 1;
        return sessionCalls === 1 ? Response.json(null) : Response.json({ csrf_token: "fresh-token" });
      }
      if (path === "/merchant/api/v1/products/import-drafts") {
        const token = init?.headers?.["x-csrf-token"] ?? "";
        sentTokens.push(token);
        if (token === "stale-token") return csrfProblem("missing or invalid CSRF token");
        return Response.json({
          draft_id: "draft-1",
          digest: "sha256:one",
          preview: { rows_total: 18, added: 18, updated: 0, unchanged: 0, removed: 0 },
        });
      }
      return Response.json({});
    });
    await loadPage(context);
    runInContext('CSRF = "stale-token"', context);

    await runInContext(
      'submitImportTable({ products: [{ sku: "SKU1", title: "商品", price: 10 }] })',
      context,
    );
    await eventually(() => (elements["presult"]?.innerHTML ?? "").includes("draft-1"));

    expect(sentTokens).toEqual(["stale-token", "fresh-token"]);
    expect(sessionCalls).toBe(2);
    expect(elements["bar"]?.className).not.toBe("err");
  });

  it("does not retry a 403 that is not the CSRF gate", async () => {
    const elements: Record<string, Element> = {};
    const sentTokens: string[] = [];
    let sessionCalls = 0;
    const context = createPageContext(elements, async (path, init) => {
      if (path === "/merchant/api/session") {
        sessionCalls += 1;
        return Response.json(null);
      }
      if (path === "/merchant/api/v1/products/import-drafts") {
        sentTokens.push(init?.headers?.["x-csrf-token"] ?? "");
        return csrfProblem("missing permission: products:import");
      }
      return Response.json({});
    });
    await loadPage(context);
    runInContext('CSRF = "current-token"', context);

    await runInContext("submitImportTable({ products: [] })", context);
    await eventually(() => (elements["bar"]?.textContent ?? "").includes("missing permission"));

    expect(sentTokens).toEqual(["current-token"]);
    expect(sessionCalls).toBe(1);
  });

  it("applies the same recovery to the tabular upload endpoint", async () => {
    const elements: Record<string, Element> = {};
    const sentTokens: string[] = [];
    let sessionCalls = 0;
    const context = createPageContext(elements, async (path, init) => {
      if (path === "/merchant/api/session") {
        sessionCalls += 1;
        return sessionCalls === 1 ? Response.json(null) : Response.json({ csrf_token: "fresh-token" });
      }
      if (path === "/merchant/api/v1/products/import-parse?format=csv") {
        const token = init?.headers?.["x-csrf-token"] ?? "";
        sentTokens.push(token);
        if (token === "stale-token") return csrfProblem("missing or invalid CSRF token");
        return Response.json({ ok: true, report: { rows: 1, format: "csv" }, table: { products: [] } });
      }
      return Response.json({});
    });
    await loadPage(context);
    runInContext('CSRF = "stale-token"', context);

    const result = await runInContext('sendUpload("csv", "sku,title\\nSKU1,商品", true)', context);

    expect(result).toMatchObject({ ok: true });
    expect(sentTokens).toEqual(["stale-token", "fresh-token"]);
    expect(sessionCalls).toBe(2);
  });
});
