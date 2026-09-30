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
/** 已部署实例目录连接入口：认证、CSRF、幂等及凭据投影边界。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createContext, runInContext } from "node:vm";
import { renderMerchantManagementPage } from "../src/http/merchant-management/page.js";
import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import { createMerchantManagementApiHandler } from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";

const ORIGIN = "https://merchant.example";
const db = new DatabaseSync(":memory:");
const sessions = new MerchantAdminSessions({ db });
let server: Server;
let base: string;
let beginCalls = 0;
let failBegin = false;
let summaryErrorCode: string | undefined;
let publicationCalls = 0;
let publicationFail = false;
const publicationDraft = {
  schema_version: "0.1", draft_id: "flp_test_123456789abc", digest: "sha256:test",
  created_at: "2026-09-30T00:00:00Z", expires_at: "2026-09-30T00:15:00Z", products_digest: "sha256:products",
  binding: { agent_id: "cagt_test", merchant_id: "mkt_test", binding_id: "binding_test", key_id: "key_test", runtime_origin: ORIGIN },
  items: [],
};
beforeAll(async () => {
  server = createServer(createMerchantManagementApiHandler({
    merchantId: "owner-connection-test", generation: () => 1, runtimeVersion: "test",
    sessions, allowedOrigins: [ORIGIN], listPending: () => [],
    mintCandidateConfirmation: () => "unused", executeDecision: async () => {},
    drafts: new MerchantImportDraftStore({ db }), operations: new MerchantManagementOperationStore({ db }),
    serviceState: new MutableServiceState("OPERATING"),
    readiness: async () => ({ ready: false, checks: {} }),
    fileListingPublication: {
      preview: async () => publicationDraft,
      getDraft: async () => ({ found: true, draft: publicationDraft, receipts: [] }),
      commit: async () => {
        publicationCalls += 1;
        if (publicationFail) throw new Error("upstream URL contains MUST_NOT_LEAK");
        return { draft_id: publicationDraft.draft_id, digest: publicationDraft.digest, status: "succeeded", succeeded: 1, failed: 0, pending: 0,
          results: [{ sku: "SKU1", status: "succeeded", listing_id: "listing_test" }] };
      },
    },
    catalogConnection: {
      getSummary: async () => ({ status: "preparing", published: false, device_code: "MUST_NOT_LEAK", user_code: "SAMPLE-CODE",
        ...(summaryErrorCode !== undefined ? { errorCode: summaryErrorCode } : {}),
      }),
      getPairing: async () => ({ user_code: "SAMPLE-CODE", verification_uri: "https://catalog.example/portal/connect/test", expires_at: "2030-01-01T00:00:00Z", grant: "MUST_NOT_LEAK" }),
      begin: async () => { beginCalls += 1; if (failBegin) throw new Error("MUST_NOT_LEAK"); },
    },
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});
async function login(role: "owner" | "operator" = "owner") {
  const { sessionId } = sessions.createSession({ principalId: `actor-${role}`, merchantId: "owner-connection-test", role });
  const cookie = `${ADMIN_SESSION_COOKIE}=${sessionId}`;
  const response = await fetch(base + "/merchant/api/session", { headers: { cookie } });
  const session = await response.json() as { csrf_token: string };
  return { cookie, csrf: session.csrf_token };
}
async function begin(auth: Awaited<ReturnType<typeof login>>, key: string, guards = true) {
  return fetch(base + "/merchant/api/v1/catalog/connect/begin", {
    method: "POST",
    headers: { cookie: auth.cookie, "content-type": "application/json", ...(guards ? { origin: ORIGIN, "x-csrf-token": auth.csrf } : {}) },
    body: JSON.stringify({ idempotency_key: key }),
  });
}

describe("runtime Catalog connection API", () => {
  it("product publication requires owner, CSRF and explicit confirmation; reads and preview cannot publish", async () => {
    const owner = await login();
    const operator = await login("operator");
    const post = (auth: typeof owner, path: string, body: unknown, guards = true) => fetch(base + "/merchant/api/v1" + path, {
      method: "POST", headers: { cookie: auth.cookie, "content-type": "application/json", ...(guards ? { origin: ORIGIN, "x-csrf-token": auth.csrf } : {}) }, body: JSON.stringify(body),
    });
    const draftPath = "/products/publication-drafts/" + publicationDraft.draft_id;
    const commitPath = draftPath + "/commit";
    const confirmation = { expected_digest: publicationDraft.digest, confirm_publication: true };
    const before = publicationCalls;
    expect((await fetch(base + "/merchant/api/v1" + draftPath)).status).toBe(401);
    expect((await fetch(base + "/merchant/api/v1" + draftPath, { headers: { cookie: operator.cookie } })).status).toBe(403);
    expect((await fetch(base + "/merchant/api/v1" + draftPath, { headers: { cookie: owner.cookie } })).status).toBe(200);
    expect((await post(owner, "/products/publication-drafts", { selections: [{ sku: "SKU1", category: "验收测试" }] })).status).toBe(200);
    expect((await post(owner, "/products/publication-drafts", { selections: [{ sku: "SKU1", category: "验收测试", merchant_id: "evil" }] })).status).toBe(422);
    expect((await post(owner, commitPath, confirmation, false)).status).toBe(403);
    expect((await post(operator, commitPath, confirmation)).status).toBe(403);
    expect((await post(owner, commitPath, { expected_digest: publicationDraft.digest })).status).toBe(422);
    expect(publicationCalls).toBe(before);
    expect((await post(owner, commitPath, confirmation)).status).toBe(200);
    expect(publicationCalls).toBe(before + 1);
    publicationFail = true;
    try {
      const result = await post(owner, commitPath, confirmation);
      expect(result.status).toBe(503);
      expect(await result.text()).not.toContain("MUST_NOT_LEAK");
    } finally { publicationFail = false; }
  });
  it("requires an owner session for summary and pairing", async () => {
    const operator = await login("operator");
    for (const path of ["/catalog/connect", "/catalog/connect/pairing"]) {
      expect((await fetch(base + "/merchant/api/v1" + path)).status).toBe(401);
      expect((await fetch(base + "/merchant/api/v1" + path, { headers: { cookie: operator.cookie } })).status).toBe(403);
    }
  });
  it("an enabled direct connection cannot be raced by opening the legacy deployment wizard", async () => {
    const owner = await login();
    const response = await fetch(base + "/merchant/api/onboarding/intents", {
      method: "POST", headers: { cookie: owner.cookie, origin: ORIGIN, "x-csrf-token": owner.csrf, "content-type": "application/json" },
      body: JSON.stringify({ intent_id: "racing-wizard", version_digest: "sha256:test", idempotency_key: "racing-wizard" }),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("不能同时启动旧部署向导");
  });
  it("rendered product publication page never writes until explicit preview and confirmation", async () => {
    const elements: Record<string, { value: string; innerHTML: string; textContent: string; className: string; style: { display: string } }> = {};
    const requests: Array<{ path: string; body: unknown }> = [];
    const draft = { ...publicationDraft, items: [{ listing: { title: "<验收商品>", category: "验收测试" } }] };
    const context = createContext({
      URL, Date, Math,
      document: { querySelectorAll: () => [], getElementById: (id: string) => elements[id] ??= { value: "", innerHTML: "", textContent: "", className: "", style: { display: "" } } },
      fetch: async (path: string, init?: { body?: unknown }) => {
        if (path === "/merchant/api/session") return Response.json(null);
        requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (path.endsWith("/publication-drafts")) return Response.json(draft);
        if (path.endsWith("/commit")) return Response.json({ status: "succeeded", succeeded: 1, failed: 0, pending: 0, results: [] });
        return Response.json({ items: [{ sku: "SKU1", title: "商品", status: "active" }] });
      },
    });
    const script = [...renderMerchantManagementPage({ productAuthority: "file", catalogConnection: true }).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]).join("\n");
    await runInContext(script!, context);
    runInContext('ROLE = "owner"', context);
    expect(await runInContext('views.products()', context)).toContain("预览公开内容");
    expect(requests.filter((r) => r.path.includes("publication-drafts"))).toHaveLength(0);
    runInContext('document.getElementById("publication-selection").value = "SKU1 | 验收测试"', context);
    await runInContext('previewPublication()', context);
    expect(elements["publication-result"]?.innerHTML).toContain("&lt;验收商品&gt;");
    expect(requests.some((r) => r.path.endsWith("/commit"))).toBe(false);
    await runInContext('commitPublication()', context);
    expect(requests.filter((r) => r.path.endsWith("/commit"))).toEqual([{ path: "/merchant/api/v1/products/publication-drafts/flp_test_123456789abc/commit", body: { expected_digest: "sha256:test", confirm_publication: true } }]);
  });
  it("summary never exposes pairing or device credentials; pairing has an explicit whitelist", async () => {
    const owner = await login();
    const summary = await (await fetch(base + "/merchant/api/v1/catalog/connect", { headers: { cookie: owner.cookie } })).json();
    expect(summary).toEqual({ status: "preparing", published: false, agentId: null, bindingId: null, bindingExpiresAt: null, errorCode: null });
    const pairing = await (await fetch(base + "/merchant/api/v1/catalog/connect/pairing", { headers: { cookie: owner.cookie } })).json();
    expect(pairing).toEqual({ pairing: { user_code: "SAMPLE-CODE", verification_uri: "https://catalog.example/portal/connect/test", expires_at: "2030-01-01T00:00:00Z" } });
    summaryErrorCode = "upstream body MUST_NOT_LEAK";
    try {
      const rejected = await (await fetch(base + "/merchant/api/v1/catalog/connect", { headers: { cookie: owner.cookie } })).json() as { errorCode: string };
      expect(rejected.errorCode).toBe("CATALOG_CONNECTION_UNAVAILABLE");
      expect(JSON.stringify(rejected)).not.toContain("MUST_NOT_LEAK");
    } finally { summaryErrorCode = undefined; }
  });
  it("begin requires CSRF and owner; replay never creates another enrollment", async () => {
    const owner = await login();
    const operator = await login("operator");
    expect((await begin(owner, "missing-guards", false)).status).toBe(403);
    expect((await begin(operator, "operator-begin")).status).toBe(403);
    const before = beginCalls;
    const first = await begin(owner, "same-begin");
    expect(first.status).toBe(200);
    const receipt = await first.json();
    expect(await (await begin(owner, "same-begin")).json()).toEqual(receipt);
    expect(beginCalls - before).toBe(1);
  });
  it("uncertain external outcome is retained, without leaking the error or blindly retrying", async () => {
    const owner = await login();
    failBegin = true;
    try {
      const before = beginCalls;
      const response = await begin(owner, "uncertain-begin");
      expect(response.status).toBe(202);
      const receipt = await response.json() as { status: string };
      expect(receipt.status).toBe("unknown");
      expect(JSON.stringify(receipt)).not.toContain("MUST_NOT_LEAK");
      expect(await (await begin(owner, "uncertain-begin")).json()).toEqual(receipt);
      expect(beginCalls - before).toBe(1);
    } finally { failBegin = false; }
  });
  it("page loads only safe status until the owner requests pairing, and rejects credential-bearing links", async () => {
    let pairingReads = 0;
    let verificationUri = "https://user:example@catalog.example/portal/connect/test";
    const elements: Record<string, { innerHTML: string; textContent: string; className: string; style: { display: string } }> = {};
    const context = createContext({
      URL,
      document: {
        querySelectorAll: () => [],
        getElementById: (id: string) => elements[id] ??= { innerHTML: "", textContent: "", className: "", style: { display: "" } },
      },
      fetch: async (requestPath: string) => {
        if (requestPath === "/merchant/api/session") return new Response("null");
        if (requestPath.endsWith("/pairing")) {
          pairingReads += 1;
          return Response.json({ pairing: { user_code: "<SAMPLE-CODE>", verification_uri: verificationUri, expires_at: "2030-01-01" } });
        }
        return Response.json({ status: "awaiting_confirmation", published: false });
      },
    });
    const script = renderMerchantManagementPage({ catalogConnection: true }).match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i)?.[1];
    await runInContext(script!, context);
    runInContext('ROLE = "owner"', context);
    const panel = await runInContext('appendCatalogConnection("")', context) as string;
    expect(panel).toContain("本人查看配对信息");
    expect(panel).not.toContain("SAMPLE-CODE");
    expect(pairingReads).toBe(0);
    await runInContext("showCatalogPairing()", context);
    expect(elements["catalog-pairing"]?.innerHTML).toBe("");
    expect(elements["bar"]?.className).toBe("err");
    verificationUri = "https://catalog.example/portal/connect/test";
    await runInContext("showCatalogPairing()", context);
    expect(elements["catalog-pairing"]?.innerHTML).toContain("&lt;SAMPLE-CODE&gt;");
    expect(elements["catalog-pairing"]?.innerHTML).toContain('rel="noopener noreferrer"');
  });
});
