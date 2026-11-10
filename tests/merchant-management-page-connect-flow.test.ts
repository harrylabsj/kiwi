/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * 一次点击「授权并发起或继续连接」（stageAccessAndBegin）的行为契约。
 *
 * 页面脚本在 node:vm 里以假 DOM + 可脚本化 fetch 真实执行，断言落在编排顺序
 * 与安全边界：
 *   - 暂存成功才推进绑定；未同意、暂存失败都不产生绑定请求；
 *   - begin 幂等键持久化在 sessionStorage：结果未知或本地校验类失败都保留原键
 *     （API 侧对 pre-effect 码释放占位，见 api.ts CONNECT_BEGIN_PRE_EFFECT_CODES），
 *     同键重试/重放不会重复创建；只有 succeeded 才清键；
 *   - 已绑定实例回到「提交或更新」；一键入口只在 workbuddyAccess（*.app.workbuddy.host）
 *     且未绑定时出现——UI 与后台前置条件一致。
 */
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createContext, runInContext } from "node:vm";
import { afterAll, beforeAll } from "vitest";

import { renderMerchantManagementPage } from "../src/http/merchant-management/page.js";
import { WORKBUDDY_CUSTODY_TERMS_VERSION } from "../src/cloud/access/workbuddy-share-link.js";
import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import { createMerchantManagementApiHandler } from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { MerchantConnectError } from "../src/cloud/connect-service.js";

const RUNTIME_ORIGIN = "https://runtime.test";
const LINK = `${RUNTIME_ORIGIN}/a2a?sharecode=staged-secret-1`;
const TERMS = WORKBUDDY_CUSTODY_TERMS_VERSION;

type Element = { value: string; checked?: boolean; disabled?: boolean; innerHTML: string; textContent: string; className: string;
  style: { display: string }; setAttribute: (n: string, v: string) => void; removeAttribute: (n: string) => void;
  addEventListener: (t: string, l: () => void) => void };
interface Recorded { method: string; path: string; body: unknown }

function pageScript(options: { catalogConnection?: boolean; workbuddyAccess?: boolean }): string {
  const html = renderMerchantManagementPage(options);
  // 结束标签必须完整匹配（允许 `</script >`、大小写变体），不使用只认小写
  // 精确 `</script>` 的正则（CodeQL js/bad-tag-filter，main 上 alert #32）。
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)]
    .map((match) => match[1] ?? "")
    .join("\n");
}

function makeSessionStore(): { mock: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }; dump: () => Record<string, string> } {
  const backing: Record<string, string> = {};
  return {
    mock: {
      getItem: (k) => (k in backing ? backing[k]! : null),
      setItem: (k, v) => { backing[k] = String(v); },
      removeItem: (k) => { delete backing[k]; },
    },
    dump: () => ({ ...backing }),
  };
}

interface PageHandle {
  elements: Record<string, Element>;
  posts: Recorded[];
  storageKey: () => string | undefined;
  storageDump: () => Record<string, string>;
  run: (expression: string) => Promise<unknown>;
  set: (statements: string) => void;
  eventually: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
}

async function loadConnectPage(options: {
  connect: Record<string, unknown>;
  access: Record<string, unknown>;
  workbuddyAccess?: boolean;
  shareLinkResponse?: () => Response;
  beginResponses?: Array<() => Response>;
  /** 传入外部 session 存储：跨“刷新”（重新执行页面脚本）恢复幂等键用。 */
  sessionStore?: ReturnType<typeof makeSessionStore>;
  /** sessionStorage 不可用模拟：所有访问都抛错（页面必须 try/catch 降级）。 */
  storageUnavailable?: boolean;
  windowConfirm?: () => boolean;
}): Promise<PageHandle> {
  const elements: Record<string, Element> = {};
  const posts: Recorded[] = [];
  const session = options.sessionStore ?? makeSessionStore();
  const storage = options.storageUnavailable === true
    ? { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); }, removeItem: () => { throw new Error("SecurityError"); } }
    : session.mock;
  const fetchImpl = async (path: string | URL | Request, init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof path === "string" ? path : path instanceof URL ? path.href : path.url;
    const route = url.replace(/^https?:\/\/[^/]+/, "");
    if (route === "/merchant/api/session") {
      return Response.json({ csrf_token: "test-csrf", role: "owner", merchant_id: "m1" });
    }
    if (init?.method === "POST") {
      posts.push({
        method: "POST",
        path: route,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (route === "/merchant/api/v1/catalog/access/share-link") {
        return options.shareLinkResponse ? options.shareLinkResponse() : Response.json({ access: options.access });
      }
      if (route === "/merchant/api/v1/catalog/connect/begin") {
        const next = options.beginResponses?.shift();
        return next ? next() : Response.json({ status: "succeeded" });
      }
      return Response.json({ ok: true });
    }
    if (route === "/merchant/api/v1/runtime/status") {
      return Response.json({ merchant_name: "S", service_state: "OPERATING", generation: "1",
        runtime_version: "t", api_version: "1", observed_at: "t", merchant_name_needs_update: false,
        readiness: { ready: true, failed_checks: [] }, capabilities: { management_page: true, dialog_tools: false } });
    }
    if (route === "/merchant/api/v1/catalog/connect") return Response.json(options.connect);
    if (route === "/merchant/api/v1/catalog/access") return Response.json({ access: options.access });
    return Response.json({});
  };
  const context = createContext({
    URL, Date, Math, Response, fetch: fetchImpl, setTimeout,
    sessionStorage: storage,
    window: { confirm: options.windowConfirm ?? (() => true) },
    document: {
      querySelectorAll: () => [],
      getElementById: (id: string) =>
        (elements[id] ??= {
          value: "", innerHTML: "", textContent: "", className: "", style: { display: "" },
          setAttribute: () => {}, removeAttribute: () => {}, addEventListener: () => {},
        }),
    },
  });
  await runInContext(pageScript({ catalogConnection: true, workbuddyAccess: options.workbuddyAccess ?? true }), context);
  const eventually = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error("condition was not met in time");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  // 等首轮 refresh 落定（访问卡片是串联的最后一环）：catalogConnectionState /
  // catalogAccessState 就绪后，编排函数读到的才是与后台一致的状态。
  await eventually(() => (elements["view"]?.innerHTML ?? "").includes("WorkBuddy 分享码"));
  return {
    elements, posts, storageKey: () => session.dump()["kiwi-catalog-connect-key"],
    storageDump: () => session.dump(),
    run: async (expression: string) => runInContext(expression, context),
    set: (statements: string) => { runInContext(statements, context); },
    eventually,
  };
}

const problem = (status: number, detail: string): Response =>
  Response.json({ title: "请求未完成", status, detail, code: "INVALID" }, { status, headers: { "content-type": "application/problem+json" } });

describe("merchant workbench one-click connect flow (stageAccessAndBegin)", () => {
  it("展示目录账户并按权威状态禁用重复授权，输入新链接后可更新", async () => {
    const page = await loadConnectPage({ connect: { status: "published", bindingId: "b1", published: true },
      access: { status: "active", consentGranted: true } });
    const html = page.elements["view"]!.innerHTML;
    expect(html).toContain('id="bound-account"');
    expect(html).toContain('查看代管授权与使用说明');
    expect(html).toContain('查看开放询价授权与使用说明');
    expect(html).toContain('id="access-submit"');
    page.set('$("access-link").value = ""; updateAccessButton();');
    expect(page.elements["access-submit"]!.disabled).toBe(true);
    page.set('$("access-link").value = "https://example.test/new"; updateAccessButton();');
    expect(page.elements["access-submit"]!.disabled).toBe(false);
    page.set('showPublicInquiryStatus({granted:true, policyActive:true, localEnabled:true});');
    expect(page.elements["inquiry-submit"]!.disabled).toBe(true);
    page.set('showPublicInquiryStatus({granted:false});');
    expect(page.elements["inquiry-submit"]!.disabled).toBe(false);
  });

  it("一次点击：同意后先加密暂存、成功后才发起绑定，本人确认文案保留", async () => {
    let stageCalls = 0;
    const page = await loadConnectPage({
      connect: { status: "preparing", bindingId: null, published: false },
      access: { status: "none" },
      shareLinkResponse: () => {
        stageCalls += 1;
        return Response.json({ access: { status: "pending", statusReason: "local_staged", consentGranted: true } });
      },
      beginResponses: [() => Response.json({ status: "succeeded" })],
    });
    page.set(`$("access-link").value = ${JSON.stringify(LINK)}; $("access-consent").checked = true;`);
    await page.run("stageAccessAndBegin()");
    await page.eventually(() => page.posts.some((p) => p.path === "/merchant/api/v1/catalog/connect/begin"));

    expect(stageCalls).toBe(1);
    expect(page.posts.map((p) => p.path)).toEqual([
      "/merchant/api/v1/catalog/access/share-link", "/merchant/api/v1/catalog/connect/begin",
    ]);
    expect(page.posts[0]!.body).toMatchObject({ link: LINK, consent_terms_version: TERMS });
    expect(typeof (page.posts[1]!.body as { idempotency_key: string }).idempotency_key).toBe("string");
    await page.eventually(() => (page.elements["bar"]?.textContent ?? "").includes("连接申请已准备"));
    // 本人确认仍保留：成功文案指向配对信息与目录确认，而不是宣布已连接。
    expect(page.elements["bar"]?.textContent).toContain("请本人查看配对信息并确认公开资料");
    expect(page.storageKey()).toBeUndefined();
    expect(page.elements["access-link"]?.value).toBe("");
    expect(page.elements["access-consent"]?.checked).toBe(false);
  });

  it("未同意：不暂存、不发起绑定，提示先勾选代管授权", async () => {
    const page = await loadConnectPage({
      connect: { status: "preparing", bindingId: null, published: false },
      access: { status: "none" },
    });
    page.set(`$("access-link").value = ${JSON.stringify(LINK)};`);
    await page.run("stageAccessAndBegin()");
    await page.eventually(() => (page.elements["bar"]?.textContent ?? "").includes("请先勾选并同意"));
    expect(page.posts).toHaveLength(0);
    expect(page.storageKey()).toBeUndefined();
  });

  it("暂存失败：停在暂存错误，绝不推进到绑定", async () => {
    const page = await loadConnectPage({
      connect: { status: "preparing", bindingId: null, published: false },
      access: { status: "none" },
      shareLinkResponse: () => problem(422, "需要先勾选并同意《分享码代管授权》后才能提交分享链接"),
    });
    page.set(`$("access-link").value = ${JSON.stringify(LINK)}; $("access-consent").checked = true;`);
    await page.run("stageAccessAndBegin()");
    await page.eventually(() => (page.elements["bar"]?.textContent ?? "").includes("分享链接暂存未确认"));
    expect(page.posts.map((p) => p.path)).toEqual(["/merchant/api/v1/catalog/access/share-link"]);
    expect(page.storageKey()).toBeUndefined();
  });

  it("绑定结果未知：保留幂等键并提示先查状态，重复点击不换键", async () => {
    const page = await loadConnectPage({
      connect: { status: "preparing", bindingId: null, published: false },
      access: { status: "pending", statusReason: "local_staged", consentGranted: true },
      beginResponses: [() => Response.json({ status: "unknown" }), () => Response.json({ status: "unknown" })],
    });
    await page.run("stageAccessAndBegin()"); // 已暂存且未填链接 → 直接继续绑定
    await page.eventually(() => (page.elements["bar"]?.textContent ?? "").includes("连接结果尚未确认"));
    const first = page.posts.find((p) => p.path === "/merchant/api/v1/catalog/connect/begin")!;
    expect(first).toBeDefined();
    expect(page.storageKey()).toBe((first.body as { idempotency_key: string }).idempotency_key);

    await page.run("stageAccessAndBegin()"); // 再次点击：同一幂等键
    await page.eventually(() => page.posts.filter((p) => p.path === "/merchant/api/v1/catalog/connect/begin").length === 2);
    const second = page.posts.filter((p) => p.path === "/merchant/api/v1/catalog/connect/begin")[1]!;
    expect((second.body as { idempotency_key: string }).idempotency_key)
      .toBe((first.body as { idempotency_key: string }).idempotency_key);
    expect(page.storageKey()).toBeDefined();
  });

  it("重试：本地校验类失败（422）后保留原键，同键重试成功并清键", async () => {
    const page = await loadConnectPage({
      connect: { status: "preparing", bindingId: null, published: false },
      access: { status: "pending", statusReason: "local_staged", consentGranted: true },
      beginResponses: [
        () => problem(422, "请先提交并授权本实例的 WorkBuddy 分享链接，再发起目录连接。"),
        () => Response.json({ status: "succeeded" }),
      ],
    });
    await page.run("stageAccessAndBegin()");
    await page.eventually(() => (page.elements["bar"]?.textContent ?? "").includes("请先提交并授权"));
    const first = page.posts.find((p) => p.path === "/merchant/api/v1/catalog/connect/begin")!;
    expect(page.storageKey()).toBe((first.body as { idempotency_key: string }).idempotency_key);

    await page.run("stageAccessAndBegin()");
    await page.eventually(() => (page.elements["bar"]?.textContent ?? "").includes("连接申请已准备"));
    const seconds = page.posts.filter((p) => p.path === "/merchant/api/v1/catalog/connect/begin");
    expect(seconds).toHaveLength(2);
    expect((seconds[1]!.body as { idempotency_key: string }).idempotency_key)
      .toBe((first.body as { idempotency_key: string }).idempotency_key);
    expect(page.storageKey()).toBeUndefined();
  });

  it("旧绑定更新流程：已绑定或已发布回到「提交或更新」，一键入口不再出现", async () => {
    for (const connect of [
      { status: "preparing", bindingId: "bnd_1", published: false },
      { status: "published", bindingId: "bnd_1", published: true },
    ]) {
      const page = await loadConnectPage({ connect, access: { status: "active" } });
      await page.eventually(() => (page.elements["view"]?.innerHTML ?? "").includes("WorkBuddy 分享码"));
      const html = page.elements["view"]!.innerHTML;
      expect(html).toContain('onclick="submitAccessLink()"');
      expect(html).not.toContain('onclick="stageAccessAndBegin()"');
    }
  });

  it("目录已有配置（catalog_access_exists）：文案指向权威版本显式更新，不显示已生效", async () => {
    const page = await loadConnectPage({
      connect: { status: "preparing", bindingId: "bnd_1", published: false },
      access: { status: "invalid", statusReason: "catalog_access_exists" },
    });
    await page.eventually(() => (page.elements["view"]?.innerHTML ?? "").includes("目录已有分享码配置"));
    const html = page.elements["view"]!.innerHTML;
    expect(html).toContain("本次绑定没有覆盖它");
    expect(html).toContain("提交或更新");
    expect(html).not.toContain("已加密暂存");
  });

  it("一键入口只在 workbuddyAccess 且未绑定时出现；非 workbuddy 实例保持「发起或继续连接」", async () => {
    const workbuddy = await loadConnectPage({
      connect: { status: "preparing", bindingId: null, published: false }, access: { status: "none" },
    });
    await workbuddy.eventually(() => (workbuddy.elements["view"]?.innerHTML ?? "").includes("WorkBuddy 分享码"));
    expect(workbuddy.elements["view"]!.innerHTML).toContain('onclick="stageAccessAndBegin()"');

    const nonWorkbuddy = await loadConnectPage({
      connect: { status: "preparing", bindingId: null, published: false }, access: { status: "none" },
      workbuddyAccess: false,
    });
    await nonWorkbuddy.eventually(() => (nonWorkbuddy.elements["view"]?.innerHTML ?? "").includes("WorkBuddy 分享码"));
    const html = nonWorkbuddy.elements["view"]!.innerHTML;
    expect(html).toContain('onclick="beginCatalogConnect()"');
    expect(html).not.toContain('onclick="stageAccessAndBegin()"');
  });
});

describe("begin key persistence across reload", () => {
  const baseOptions = () => ({
    connect: { status: "preparing", bindingId: null, published: false },
    access: { status: "pending", statusReason: "local_staged", consentGranted: true },
    beginResponses: [() => Response.json({ status: "unknown" })],
  });

  it("sessionStorage 可用：unknown 后跨刷新恢复同一幂等键", async () => {
    const store = makeSessionStore();
    const first = await loadConnectPage({ ...baseOptions(), sessionStore: store });
    await first.run("stageAccessAndBegin()");
    await first.eventually(() => (first.elements["bar"]?.textContent ?? "").includes("连接结果尚未确认"));
    const persistedKey = first.storageKey();
    expect(persistedKey).toBeDefined();

    // 模拟刷新：同一存储、重新执行整份页面脚本，begin 必须沿用持久化键。
    const second = await loadConnectPage({
      ...baseOptions(), sessionStore: store,
      beginResponses: [() => Response.json({ status: "unknown" })],
    });
    await second.run("stageAccessAndBegin()");
    await second.eventually(() => second.posts.some((p) => p.path === "/merchant/api/v1/catalog/connect/begin"));
    const beginBodies = second.posts
      .filter((p) => p.path === "/merchant/api/v1/catalog/connect/begin")
      .map((p) => (p.body as { idempotency_key: string }).idempotency_key);
    expect(beginBodies).toEqual([persistedKey]);
  });

  it("sessionStorage 不可用：页面照常降级运行（try/catch），刷新后只能换新键", async () => {
    const first = await loadConnectPage({ ...baseOptions(), storageUnavailable: true });
    await first.run("stageAccessAndBegin()");
    await first.eventually(() => (first.elements["bar"]?.textContent ?? "").includes("连接结果尚未确认"));
    expect(first.posts.some((p) => p.path === "/merchant/api/v1/catalog/connect/begin")).toBe(true);

    // 刷新后存储仍不可用：无法恢复旧键，只能生成新键（同键重放保护仅在存储可用时成立）。
    const second = await loadConnectPage({
      ...baseOptions(), storageUnavailable: true,
      beginResponses: [() => Response.json({ status: "unknown" })],
    });
    await second.run("stageAccessAndBegin()");
    await second.eventually(() => second.posts.some((p) => p.path === "/merchant/api/v1/catalog/connect/begin"));
    const secondKey = (second.posts.find((p) => p.path === "/merchant/api/v1/catalog/connect/begin")!.body as { idempotency_key: string }).idempotency_key;
    expect(secondKey).not.toBe((first.posts.find((p) => p.path === "/merchant/api/v1/catalog/connect/begin")!.body as { idempotency_key: string }).idempotency_key);
  });
});

describe("bound workbench: update code and revoke (UI)", () => {
  const boundOptions = (access: Record<string, unknown>) => ({
    connect: { status: "preparing", bindingId: "bnd_1", published: false },
    access,
  });

  it("已绑定换码：提交走 /catalog/access/share-link 并显示已提交；回执不含链接", async () => {
    let seenBody: unknown;
    const page = await loadConnectPage({
      ...boundOptions({ status: "active", consentGranted: true }),
      shareLinkResponse: () => {
        return Response.json({ access: { status: "active", consentGranted: true } });
      },
    });
    // 捕获 share-link 请求体。
    page.set(`$("access-link").value = ${JSON.stringify(LINK)}; $("access-consent").checked = true;`);
    // loadConnectPage 的 fetch 桩固定返回 options.shareLinkResponse；请求体在 posts 里断言。
    await page.run("submitAccessLink()");
    await page.eventually(() => (page.elements["bar"]?.textContent ?? "").includes("已提交"));
    const shareLinkPost = page.posts.find((p) => p.path === "/merchant/api/v1/catalog/access/share-link");
    expect(shareLinkPost).toBeDefined();
    seenBody = shareLinkPost!.body;
    expect(seenBody).toMatchObject({ link: LINK, consent_terms_version: TERMS });
    expect(JSON.stringify(page.posts)).not.toContain("staged-secret-1X");
  });

  it("撤销：确认后走 /catalog/access/revoke 并显示已撤销", async () => {
    const page = await loadConnectPage({
      ...boundOptions({ status: "active", consentGranted: true }),
      windowConfirm: () => true,
    });
    await page.run("revokeAccess()");
    await page.eventually(() => (page.elements["bar"]?.textContent ?? "").includes("已撤销"));
    expect(page.posts.some((p) => p.path === "/merchant/api/v1/catalog/access/revoke")).toBe(true);
  });

  it("撤销需确认：取消时不发请求", async () => {
    const page = await loadConnectPage({
      ...boundOptions({ status: "active", consentGranted: true }),
      windowConfirm: () => false,
    });
    await page.run("revokeAccess()");
    expect(page.posts.some((p) => p.path === "/merchant/api/v1/catalog/access/revoke")).toBe(false);
  });
});

describe("catalog connect begin API: pre-effect failures release the idempotency key", () => {
  const ORIGIN = "https://merchant.example";
  const db = new DatabaseSync(":memory:");
  const sessions = new MerchantAdminSessions({ db });
  let server: Server;
  let base: string;
  let beginBehavior: () => Promise<void> = async () => {};
  let beginCalls = 0;

  beforeAll(async () => {
    server = createServer(createMerchantManagementApiHandler({
      merchantId: "m-pre-effect", generation: () => 1, runtimeVersion: "test",
      sessions, allowedOrigins: [ORIGIN], listPending: () => [],
      mintCandidateConfirmation: () => "unused", executeDecision: async () => {},
      drafts: new MerchantImportDraftStore({ db }),
      operations: new MerchantManagementOperationStore({ db }),
      serviceState: new MutableServiceState("OPERATING"),
      readiness: async () => ({ ready: false, checks: {} }),
      catalogConnection: {
        getSummary: async () => ({ status: "preparing", published: false }),
        getPairing: async () => null,
        begin: async () => { beginCalls += 1; await beginBehavior(); },
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const login = async (): Promise<{ cookie: string; csrf: string }> => {
    const { sessionId } = sessions.createSession({ principalId: "actor-owner", merchantId: "m-pre-effect", role: "owner" });
    const cookie = `${ADMIN_SESSION_COOKIE}=${sessionId}`;
    const session = await (await fetch(`${base}/merchant/api/session`, { headers: { cookie } })).json() as { csrf_token: string };
    return { cookie, csrf: session.csrf_token };
  };
  const beginPost = (auth: { cookie: string; csrf: string }, key: string): Promise<Response> =>
    fetch(`${base}/merchant/api/v1/catalog/connect/begin`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/json", origin: ORIGIN, "x-csrf-token": auth.csrf },
      body: JSON.stringify({ idempotency_key: key }),
    });

  it("STATE_INVALID 释放占位：同键重试真正执行且成功；unknown 则保留回执不重复执行", async () => {
    const auth = await login();
    // 1) 本地校验类失败（发生在触达目录之前）→ 422，可原键重试。
    beginBehavior = async () => { throw new MerchantConnectError("STATE_INVALID", "本地状态无效（测试）"); };
    const first = await beginPost(auth, "retry-key-1");
    // 可确定错误：422 + 自有文案（释放占位发生在触达目录之前）。
    expect(first.status).toBe(422);
    expect(((await first.json()) as { detail: string }).detail).toContain("本地状态无效");
    // 2) 同键重试：真正执行 begin。
    beginBehavior = async () => {};
    const second = await beginPost(auth, "retry-key-1");
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status: string }).status).toBe("succeeded");
    // 第一次 attempt 在分类为 pre-effect 前已进入 stub（远端无副作用），重试是第二次真实执行。
    expect(beginCalls).toBe(2);
    // 3) 成功后同键重放：回执重放，不再执行。
    const replay = await beginPost(auth, "retry-key-1");
    expect(((await replay.json()) as { status: string }).status).toBe("succeeded");
    expect(beginCalls).toBe(2);
    // 4) 结果未知：同键拿到同一 unknown 回执，begin 不重复执行（2 次成功路径 + 1 次 unknown）。
    beginBehavior = async () => { throw new Error("remote enrollment may exist"); };
    const unknown = await beginPost(auth, "unknown-key-1");
    // 未知结果：HTTP 202 + unknown 回执（不是成功的 200）。
    expect(unknown.status).toBe(202);
    expect(((await unknown.json()) as { status: string }).status).toBe("unknown");
    const replayUnknown = await beginPost(auth, "unknown-key-1");
    // 同键重放走回执重放分支：HTTP 200（202 仅属首次未知执行），体内仍为 unknown。
    expect(replayUnknown.status).toBe(200);
    expect(((await replayUnknown.json()) as { status: string }).status).toBe("unknown");
    expect(beginCalls).toBe(3);
    // 成功路径回执是 200；同键重放同一回执也是 200。
    beginBehavior = async () => {};
    const okReceipt = await beginPost(auth, "ok-key-1");
    expect(okReceipt.status).toBe(200);
    const okReplay = await beginPost(auth, "ok-key-1");
    expect(okReplay.status).toBe(200);
    expect(beginCalls).toBe(4);
  });
});
