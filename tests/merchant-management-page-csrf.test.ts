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
  id?: string;
  appendChild?: (child: Element) => void;
  value: string;
  innerHTML: string;
  textContent: string;
  className: string;
  style: { display: string };
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
  querySelectorAll: (selector: string) => unknown[];
};

function fakeElement(): Element {
  return {
    value: "", innerHTML: "", textContent: "", className: "", style: { display: "" },
    setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {}, querySelectorAll: () => [],
  };
}

function pageScript(weixinChannel: boolean): string {
  const html = renderMerchantManagementPage({ productAuthority: "file", weixinChannel });
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
    URLSearchParams,
    window: { location: { search: "" } },
    Date,
    Math,
    Response,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    document: {
      querySelectorAll: () => [],
      createElement: () => fakeElement(),
      getElementById: (id: string) => (elements[id] ??= {
        ...fakeElement(),
        appendChild(child: Element) { if (child.id) elements[child.id] = child; },
      }),
    },
  });
}

async function loadPage(context: ReturnType<typeof createContext>, weixinChannel = false): Promise<void> {
  await runInContext(pageScript(weixinChannel), context);
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

describe("merchant workbench view lifecycle", () => {
  it("renders and mounts Weixin and Alipay on the currently attached nodes", async () => {
    const elements: Record<string, Element> = { view: fakeElement() };
    let html = "";
    // Replacing innerHTML creates a new panel even if the HTML is identical, as in the browser.
    Object.defineProperty(elements.view, "innerHTML", {
      get: () => html,
      set: (value: string) => {
        html = value;
        delete elements["weixin-panel"];
        delete elements["alipay-form"];
        if (value.includes('id="weixin-panel"')) {
          elements["weixin-panel"] = { ...fakeElement(), innerHTML: "正在读取连接状态…" };
        }
        if (value.includes('id="alipay-form"')) elements["alipay-form"] = fakeElement();
      },
    });
    const context = createPageContext(elements, async (path) => {
      switch (path) {
        case "/merchant/api/session":
          return Response.json({ role: "owner", can_manage_alipay_collection: true });
        case "/merchant/api/v1/channels/weixin":
          return Response.json({ configured: false, status: "disconnected" });
        case "/merchant/api/v1/collection/alipay":
          return Response.json({ enabled: false });
        case "/merchant/api/v1/runtime/status":
          return Response.json({ service_state: "OPERATING", capabilities: {} });
        default:
          throw new Error(`unexpected request ${path}`);
      }
    });
    await loadPage(context, true);
    expect(html).toContain("运行状态");

    runInContext('current = "weixin"; refresh();', context);
    await tick();
    expect(elements["weixin-panel"]?.innerHTML).toContain("生成微信二维码");
    expect(runInContext('typeof $("weixin-begin").onclick', context)).toBe("function");

    runInContext('current = "collection"; refresh();', context);
    expect(html).not.toContain('id="weixin-panel"');
    await tick();
    expect(html).toContain("支付宝收款");
    expect(elements["alipay-form"]).toHaveProperty("onsubmit", expect.any(Function));
  });

  it("loads and saves the selected owner model from the Weixin view", async () => {
    expect(renderMerchantManagementPage({ productAuthority: "file", weixinChannel: true }))
      .not.toMatch(/(?:type|name)=["']password/);
    const elements: Record<string, Element> = {};
    const calls: unknown[] = [];
    const providers = [
      { id: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com/v1" },
      { id: "dashscope", label: "通义千问", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    ];
    const context = createPageContext(elements, async (path, init) => {
      switch (path) {
        case "/merchant/api/session":
          return Response.json({ role: "owner", csrf_token: "fixture-csrf" });
        case "/merchant/api/v1/runtime/status":
          return Response.json({ capabilities: {} });
        case "/merchant/api/v1/channels/weixin":
          return Response.json({ configured: false, status: "disconnected" });
        case "/merchant/api/v1/channels/weixin/model":
          if (init?.body) {
            calls.push({ body: init.body, csrf: init.headers?.["x-csrf-token"] });
            return Response.json({ editable: true, active: true, credential_saved: true, provider: "dashscope", model: "qwen-plus", providers });
          }
          return Response.json({ editable: true, active: false, providers });
        default:
          throw new Error(`unexpected request ${path}`);
      }
    });
    await loadPage(context, true);
    runInContext('current = "weixin"; refresh();', context);
    await eventually(() => elements["weixin-model-form-area"]?.innerHTML.includes("测试并保存") === true);
    expect(elements["weixin-model-form-area"]!.innerHTML).toContain("通义千问");
    expect(elements["weixin-model-credential"]).toHaveProperty("type", "password");
    runInContext(`$("weixin-model-provider").value = "deepseek"; $("weixin-model-provider").onchange();`, context);
    expect(elements["weixin-model-endpoint"]?.textContent).toBe(providers[0]!.endpoint);
    runInContext(`$("weixin-model-provider").value = "dashscope";
      $("weixin-model-provider").onchange();`, context);
    expect(elements["weixin-model-endpoint"]?.textContent).toBe(providers[1]!.endpoint);
    runInContext(`$("weixin-model-id").value = "qwen-plus";
      $("weixin-model-credential").value = "merchant-fixture-secret";
      $("weixin-model-form").onsubmit({ preventDefault: function () {} });`, context);
    await eventually(() => elements["weixin-model-result"]?.textContent.includes("配置已保存") === true);
    expect(calls).toEqual([{ csrf: "fixture-csrf", body: JSON.stringify({ provider: "dashscope", model: "qwen-plus", credential: "merchant-fixture-secret" }) }]);
    expect(elements["weixin-model-credential"]?.value).toBe("");
    expect(elements["weixin-model-form-area"]?.innerHTML).not.toContain("merchant-fixture-secret");
  });

  it("ignores a stale view after a 401 and can render again when requests succeed", async () => {
    const elements: Record<string, Element> = {};
    let finishOldStatus: (response: Response) => void = () => { throw new Error("no pending status request"); };
    const oldStatus = new Promise<Response>((resolve) => { finishOldStatus = resolve; });
    let statusCalls = 0;
    const context = createPageContext(elements, async (path) => {
      switch (path) {
        case "/merchant/api/session":
          return Response.json({ role: "owner" });
        case "/merchant/api/v1/runtime/status":
          return ++statusCalls === 1 ? oldStatus : Response.json({ merchant_name: "新的店铺状态", capabilities: {} });
        case "/merchant/api/v1/channels/weixin":
          return new Response(null, { status: 401 });
        default:
          throw new Error(`unexpected request ${path}`);
      }
    });
    await loadPage(context, true);
    expect(statusCalls).toBe(1);

    runInContext('current = "weixin"; refresh();', context);
    await tick();
    expect(elements.view?.innerHTML).toContain("登录你的商家工作台");
    finishOldStatus(Response.json({ merchant_name: "过期的店铺状态" }));
    await tick();
    expect(elements.view?.innerHTML).toContain("登录你的商家工作台");

    runInContext('current = "status"; refresh();', context);
    await tick();
    expect(elements.view?.innerHTML).toContain("新的店铺状态");
  });
});

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

  it("collection preview is local, editing invalidates it, and saving needs explicit rights confirmation", async () => {
    const elements: Record<string, Element> = {};
    const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
    const context = createPageContext(elements, async (path, init) => {
      if (path === "/merchant/api/session") return Response.json(null);
      posted.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json(path.endsWith("/preview") ? { confirmation_ref: "preview-fixture" } : {});
    });
    await loadPage(context);
    const preview = () => runInContext('$("alipay-form").onsubmit({ preventDefault() {} })', context);
    runInContext(`
      Object.assign($("alipay-form"), { isConnected: true, getAttribute: () => "", reset() {} });
      Object.assign($("alipay-review-qr"), { removeAttribute() {} });
      $("alipay-qr").files = [];
      $("alipay-enabled").checked = true;
      $("alipay-recipient").value = "测试收款主体";
      $("alipay-account").value = "first@example.invalid";
      refresh = function () {};
      bindAlipayCollection();`, context);

    await preview();
    expect(elements["alipay-review-text"]?.textContent).toContain("first@example.invalid");
    runInContext('$("alipay-save").onclick()', context);
    expect(posted).toHaveLength(1);
    runInContext(`
      $("alipay-account").value = "second@example.invalid";
      $("alipay-form").oninput({ target: $("alipay-account") });
      $("alipay-rights").checked = true;
      $("alipay-rights").onchange();
      $("alipay-save").onclick();`, context);
    expect(posted).toHaveLength(1);

    await preview();
    runInContext(`
      $("alipay-rights").checked = true;
      $("alipay-rights").onchange();
      $("alipay-save").onclick();`, context);
    await eventually(() => elements["bar"]?.textContent === "收款设置已保存");
    expect(posted.at(-1)).toEqual({
      path: "/merchant/api/v1/collection/alipay",
      body: {
        expected_version: null, enabled: true, recipient: "测试收款主体", account: "second@example.invalid",
        confirmation_ref: "preview-fixture", confirm_owner_rights: true,
      },
    });
  });

  it("warns in the approval confirmation when the approved unit price exceeds the buyer counter", async () => {
    const elements: Record<string, Element> = {};
    const confirmations: string[] = [];
    const context = createPageContext(elements, async () => Response.json(null));
    context["window"] = { confirm: (message: string) => { confirmations.push(message); return false; } };
    await loadPage(context);
    await runInContext(`
      var form = {
        elements: { approved_minor: { valueAsNumber: 800 }, alipay_total_minor: { valueAsNumber: 1600 }, confirm_final_total: { checked: true } },
        querySelector: function (selector) { return selector === "button" ? {} : { textContent: "SKU-1" }; },
        getAttribute: function () { return "700"; }
      };
      $("view").querySelectorAll = function () { return [form]; };
      bindAlipayApprovals();
      form.onsubmit({ preventDefault() {} });`, context);
    expect(confirmations).toEqual([expect.stringContaining("批准单价高于买家原还价")]);
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
