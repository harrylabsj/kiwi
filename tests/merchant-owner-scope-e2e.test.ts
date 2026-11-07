/**
 * 店主金额 scope 端到端（离线）：
 *   owner 会话 + 显式申请 merchant:owner → OAuth token → MCP 工具返回金额；
 *   普通 merchant:read → 仍脱敏；
 *   operator 会话申请 merchant:owner → invalid_scope；
 *   revoke 后调用 → 401。
 *
 * 不访问生产、不使用真实凭据；ledger 与 OAuth store 均为临时/内存。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import { MerchantOAuthServer, MerchantOAuthStore } from "../src/auth/merchant-oauth.js";
import { merchantOAuthScopes } from "../src/auth/merchant-scopes.js";
import { MerchantOAuthVerifier } from "../src/auth/merchant-authorization.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { MerchantOperationStore } from "../src/merchant-core/operations.js";
import { createNegotiationObserver } from "../src/merchant/negotiation-observer.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import {
  startMerchantMcpServer,
  type MerchantMcpServerHandle,
} from "../src/mcp/merchant-server.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-11-07T06:03:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";
const VERIFIER = "owner-scope-code-verifier-0123456789abcdef0123456789";
const REDIRECT = "http://127.0.0.1:54321/oauth/callback";
const SKU = "10225485016481";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ledgerFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-owner-e2e-"));
  dirs.push(dir);
  const ledger = new LedgerStore({ dir, now: () => T0 });
  ledger.append({
    event_kind: "message_received",
    negotiation_id: "neg-owner-e2e",
    identity: {
      sender_identity: "buyer:buyer-1",
      counterparty_identity: "mkt_test",
      actor: "buyer",
    },
    capability: {
      capability: "com.harrylabsj.kiwi.shopping.negotiation",
      protocol_version: "1.0",
    },
    wire_payload: {
      action: "rfq",
      payload: {
        type: "rfq",
        terms: {
          items: [
            {
              sku: SKU,
              quantity: { value: 3, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: 9_999_00 },
            },
          ],
        },
      },
    },
    outcome: { kind: "ok" },
    occurred_at: T0,
  });
  // 商家报价：owner 投影的金额来自商家侧最近带价消息。
  ledger.append({
    event_kind: "message_sent",
    negotiation_id: "neg-owner-e2e",
    identity: {
      sender_identity: "mkt_test",
      counterparty_identity: "buyer:buyer-1",
      actor: "merchant",
    },
    capability: {
      capability: "com.harrylabsj.kiwi.shopping.negotiation",
      protocol_version: "1.0",
    },
    wire_payload: {
      action: "offer",
      payload: {
        type: "offer",
        terms: {
          items: [
            {
              sku: SKU,
              quantity: { value: 3, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: 9_999_00 },
            },
          ],
        },
      },
    },
    outcome: { kind: "ok" },
    occurred_at: "2026-11-07T06:03:30.000Z",
  });
  return dir;
}

interface Stack {
  issuer: string;
  oauth: MerchantOAuthServer;
  oauthStore: MerchantOAuthStore;
  handle: MerchantMcpServerHandle;
  close: () => Promise<void>;
}

async function startStack(): Promise<Stack> {
  const ledgerDir = ledgerFixture();
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, ?, 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, MERCHANT, T0, T0);
  const approvals = new WriteApprovalCandidateStore({
    db,
    principalId: PRINCIPAL,
    now: () => T0,
  });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    approvals,
    mode: () => "supervised",
    now: () => T0,
    a2aLedgerDir: ledgerDir,
    negotiationObserver: createNegotiationObserver({ ledgerDir }),
    commandPrincipalId: PRINCIPAL,
    operations: new MerchantOperationStore({ db, now: () => T0 }),
  });
  // 先取一个空闲端口，再用同端口启动最终服务（issuer 必须与监听地址一致）。
  const probe = await startMerchantMcpServer({ service: core, host: "127.0.0.1", port: 0 });
  const port = probe.port;
  await probe.close();
  const issuer = `http://127.0.0.1:${port}`;
  const oauthStore = new MerchantOAuthStore({ db: new DatabaseSync(":memory:"), now: () => T0 });
  const oauth = new MerchantOAuthServer({
    store: oauthStore,
    issuer,
    resource: `${issuer}/mcp`,
    connectorSource: "kiwi-merchant",
    merchantId: MERCHANT,
    scopes: merchantOAuthScopes(true),
    now: () => T0,
  });
  const handle = await startMerchantMcpServer({
    service: core,
    host: "127.0.0.1",
    port,
    oauth,
    auth: new MerchantOAuthVerifier({ store: oauthStore, expectedMerchantId: MERCHANT }),
  });
  return {
    issuer,
    oauth,
    oauthStore,
    handle,
    close: async () => {
      await handle.close();
      db.close();
    },
  };
}

const challenge = createHash("sha256").update(VERIFIER).digest("base64url");

async function bind(
  stack: Stack,
  role: string,
  scope: string,
): Promise<{ access_token: string; refresh_token: string; scope: string }> {
  const client = stack.oauthStore.registerClient({
    client_name: "owner-scope-e2e",
    redirect_uris: [REDIRECT],
  });
  const session = { principal_id: PRINCIPAL, merchant_id: MERCHANT, role };
  const page = stack.oauth.authorize(
    {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope,
      state: "state-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    },
    session,
  );
  if (page.status !== 200) {
    throw Object.assign(new Error("authorize failed"), { result: page });
  }
  const csrf = /name="csrf" value="([^"]+)"/.exec(String(page.html ?? ""))?.[1] ?? "";
  expect(csrf).not.toBe("");
  const submit = stack.oauth.authorizeSubmit({ csrf, decision: "approve" }, session);
  expect(submit.status).toBe(302);
  const location = String(submit.headers?.location ?? "");
  const code = new URL(location).searchParams.get("code") ?? "";
  expect(code).not.toBe("");
  const token = stack.oauth.token({
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
  expect(token.status).toBe(200);
  const body = token.body as { access_token: string; refresh_token: string; scope: string };
  return body;
}

async function callTool(
  issuer: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${issuer}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

describe("merchant:owner 端到端（OAuth → MCP 工具）", () => {
  it("owner 会话拿到金额；read-only 脱敏；operator 不能申请；revoke 后 401", async () => {
    const stack = await startStack();
    try {
      const owner = await bind(stack, "owner", "merchant:read merchant:owner");
      const ownerRes = await callTool(
        stack.issuer,
        owner.access_token,
        "kiwi_merchant_get_a2a_negotiation",
        { negotiation_id: "neg-owner-e2e" },
      );
      expect(ownerRes.status).toBe(200);
      const ownerBody = (await ownerRes.json()) as {
        result: { structuredContent: { negotiation: { price_minor?: number; currency?: string } } };
      };
      expect(ownerBody.result.structuredContent.negotiation.price_minor).toBe(999900);
      expect(ownerBody.result.structuredContent.negotiation.currency).toBe("CNY");

      const readOnly = await bind(stack, "owner", "merchant:read");
      const readRes = await callTool(
        stack.issuer,
        readOnly.access_token,
        "kiwi_merchant_get_a2a_negotiation",
        { negotiation_id: "neg-owner-e2e" },
      );
      const readText = await readRes.text();
      expect(readText).not.toContain("999900");

      // operator 会话即使显式申请也拿不到 owner scope（授权阶段拒绝）。
      const client = stack.oauthStore.registerClient({
        client_name: "operator-e2e",
        redirect_uris: [REDIRECT],
      });
      const denied = stack.oauth.authorize(
        {
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          scope: "merchant:read merchant:owner",
          state: "state-2",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        { principal_id: PRINCIPAL, merchant_id: MERCHANT, role: "operator" },
      );
      expect(denied.status).toBe(302);
      expect(String(denied.headers?.location ?? "")).toContain("invalid_scope");

      // 撤销 owner token 后 MCP 拒绝。
      stack.oauth.revoke({ token: owner.access_token });
      const revoked = await callTool(
        stack.issuer,
        owner.access_token,
        "kiwi_merchant_get_a2a_negotiation",
        { negotiation_id: "neg-owner-e2e" },
      );
      expect(revoked.status).toBe(401);
    } finally {
      await stack.close();
    }
  });
});
