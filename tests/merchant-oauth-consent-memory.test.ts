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
 * OAuth「记住授权」：同一 client + merchant + scope 在有效期内不再重复展示
 * 第二个「同意授权」页；scope 变化、过期、拒绝或撤销后重新要求确认。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  MerchantOAuthServer,
  MerchantOAuthStore,
  pkceS256,
  workbuddyCallbackUri,
} from "../src/auth/merchant-oauth.js";
import { MERCHANT_OAUTH_SCOPES } from "../src/auth/merchant-authorization.js";

const T0 = "2026-09-15T10:00:00.000Z";
const ISSUER = "http://127.0.0.1:9100";
const CALLBACK = workbuddyCallbackUri("kiwi-merchant");
const VERIFIER = "test-code-verifier-0123456789abcdef0123456789";
const SESSION = { principal_id: "merchant-agent:merchant-001", merchant_id: "merchant-001" };

function setup(options: { remember?: boolean; ttlMs?: number } = {}) {
  const clock = { value: T0 };
  const store = new MerchantOAuthStore({
    db: new DatabaseSync(":memory:"),
    now: () => clock.value,
  });
  const server = new MerchantOAuthServer({
    store,
    issuer: ISSUER,
    resource: `${ISSUER}/mcp`,
    connectorSource: "kiwi-merchant",
    merchantName: "Veyquo 手工陶瓷",
    merchantId: "merchant-001",
    now: () => clock.value,
    ...(options.remember === true ? { rememberConsent: true } : {}),
    ...(options.ttlMs !== undefined ? { consentTtlMs: options.ttlMs } : {}),
  });
  return { store, server, clock };
}

function registerClient(server: MerchantOAuthServer): string {
  const result = server.register({ client_name: "WorkBuddy", redirect_uris: [CALLBACK] });
  expect(result.status).toBe(201);
  return (result.body as { client_id: string }).client_id;
}

function query(clientId: string, scope = MERCHANT_OAUTH_SCOPES.join(" ")): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope,
    state: "state-abc",
    code_challenge: pkceS256(VERIFIER),
    code_challenge_method: "S256",
  };
}

function csrfOf(page: { html?: string }): string {
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1];
  expect(csrf).toBeTruthy();
  return csrf ?? "";
}

function approve(server: MerchantOAuthServer, csrf: string): string {
  const result = server.authorizeSubmit({ csrf, decision: "approve" }, SESSION);
  expect(result.status).toBe(302);
  return new URL(result.headers?.location ?? "").searchParams.get("code") ?? "";
}

function exchange(server: MerchantOAuthServer, clientId: string, code: string) {
  return server.token({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_verifier: VERIFIER,
  });
}

describe("OAuth 记住授权（consent memory）", () => {
  it("首次展示确认页；同意后同 client+scope 直接签发授权码，不再展示第二页", () => {
    const h = setup({ remember: true });
    const clientId = registerClient(h.server);

    const first = h.server.authorize(query(clientId), SESSION);
    expect(first.status).toBe(200);
    expect(first.html).toContain("同意授权");
    const code1 = approve(h.server, csrfOf(first));
    expect(exchange(h.server, clientId, code1).status).toBe(200);

    const second = h.server.authorize(query(clientId), SESSION);
    expect(second.status).toBe(302);
    expect(second.html).toBeUndefined();
    const location = new URL(second.headers?.location ?? "");
    expect(location.searchParams.get("state")).toBe("state-abc");
    const code2 = location.searchParams.get("code") ?? "";
    expect(exchange(h.server, clientId, code2).status).toBe(200);
  });

  it("scope 变化或记住授权过期后重新展示确认页", () => {
    const h = setup({ remember: true });
    const clientId = registerClient(h.server);
    const code = approve(h.server, csrfOf(h.server.authorize(query(clientId), SESSION)));
    expect(exchange(h.server, clientId, code).status).toBe(200);

    const narrower = h.server.authorize(query(clientId, "merchant:read"), SESSION);
    expect(narrower.status).toBe(200);

    h.clock.value = "2026-10-20T10:00:00.000Z"; // 35 天后
    const expired = h.server.authorize(query(clientId), SESSION);
    expect(expired.status).toBe(200);
    expect(expired.html).toContain("同意授权");
  });

  it("拒绝会忘掉此前记住的授权", () => {
    const h = setup({ remember: true });
    const clientId = registerClient(h.server);
    approve(h.server, csrfOf(h.server.authorize(query(clientId, "merchant:read"), SESSION)));

    const wider = h.server.authorize(query(clientId, "merchant:read merchant:write"), SESSION);
    expect(wider.status).toBe(200);
    const denied = h.server.authorizeSubmit({ csrf: csrfOf(wider), decision: "deny" }, SESSION);
    expect(denied.status).toBe(302);

    const again = h.server.authorize(query(clientId, "merchant:read"), SESSION);
    expect(again.status).toBe(200);
  });

  it("撤销 token 会忘掉记住的授权", () => {
    const h = setup({ remember: true });
    const clientId = registerClient(h.server);
    const code = approve(h.server, csrfOf(h.server.authorize(query(clientId), SESSION)));
    const token = exchange(h.server, clientId, code);
    expect(token.status).toBe(200);
    const access = (token.body as { access_token: string }).access_token;

    expect(h.server.authorize(query(clientId), SESSION).status).toBe(302);
    h.server.revoke({ token: access });
    const after = h.server.authorize(query(clientId), SESSION);
    expect(after.status).toBe(200);
    expect(after.html).toContain("同意授权");
  });

  it("默认关闭记住授权：每次都展示确认页（向后兼容）", () => {
    const h = setup();
    const clientId = registerClient(h.server);
    approve(h.server, csrfOf(h.server.authorize(query(clientId), SESSION)));
    const second = h.server.authorize(query(clientId), SESSION);
    expect(second.status).toBe(200);
    expect(second.html).toContain("同意授权");
  });
});
