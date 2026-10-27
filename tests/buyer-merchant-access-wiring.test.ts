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
 * B-04/B-07：WorkBuddy 商家在 Buyer 侧每一必要请求都带分享参数；缺少配置时
 * fail-closed 为 `access_unavailable`，而不是静默无码直连或误报商家拒绝。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import type { MerchantRecord } from "../src/buyer-core/service.js";

const CARD = "http://127.0.0.1:9/.well-known/agent-card.json";
const ENDPOINT = "http://127.0.0.1:9/a2a";
const CONTEXT = {
  taskId: "task-access-1",
  createdAt: "2026-10-27T00:00:00Z",
  intentBindingDigest: contentDigest({
    intent_id: "intent-access-1",
    intent_type: "purchase",
    items: [{ query: "Widget", sku: "sku-1", quantity: { value: 1 } }],
  }),
};
const INTENT = {
  intent_id: "intent-access-1",
  intent_type: "purchase",
  items: [{ query: "Widget", sku: "sku-1", quantity: { value: 1 } }],
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function merchant(withAccess: boolean): MerchantRecord {
  return {
    merchant_id: "mkt_1",
    name: "WorkBuddy Merchant",
    verified: true,
    capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"],
    agent_card_url: CARD,
    catalog_agent_id: "cagt_1",
    ...(withAccess
      ? {
          runtime_access: {
            provider: "workbuddy" as const,
            access_mode: "share_parameter" as const,
            parameter_name: "sharecode" as const,
            config_version: 1,
            adapter_version: "workbuddy-share-v1" as const,
            auth_mode: "signature" as const,
          },
        }
      : {}),
  };
}

function fetcher(
  calls: string[],
  options: {
    access?: { sendUrlFor: (url: string) => string } | null;
    hasResolver?: boolean;
    bearerToken?: string;
    signer?: import("../src/a2a/client/types.js").A2AOutboundSigner;
    capture?: Array<Record<string, string>>;
  } = {},
): A2AQuoteFetcher {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-buyer-access-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return new A2AQuoteFetcher({
    fetchImpl: ((input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const headerBag = new Headers(init?.headers ?? {});
      options.capture?.push(Object.fromEntries(headerBag.entries()));
      if (url.includes("agent-card.json")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              name: "m",
              url: ENDPOINT,
              supportedInterfaces: [{ protocolBinding: "JSONRPC", url: ENDPOINT }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 500 }));
    }) as typeof fetch,
    ...(options.bearerToken !== undefined ? { bearerToken: options.bearerToken } : {}),
    ...(options.signer !== undefined ? { signer: options.signer } : {}),
    skipDnsCheck: true,
    allowPrivateRanges: true,
    protocolStateDir: dir,
    localBuyerAgentId: "buyer-access-test",
    ...(options.hasResolver === false
      ? {}
      : {
          merchantAccess: {
            forMerchant: async () => options.access ?? null,
            forEndpoint: async () => options.access ?? null,
          },
        }),
  });
}

describe("A2AQuoteFetcher × WorkBuddy access", () => {
  it("carries the share parameter on the card read and on the RPC call", async () => {
    const calls: string[] = [];
    const access = { sendUrlFor: (url: string) => `${url}?sharecode=abc` };
    const results = await fetcher(calls, { access }).requestQuotes(INTENT, [merchant(true)], CONTEXT);
    expect(calls[0]).toBe(`GET ${CARD}?sharecode=abc`);
    expect(calls[1]).toBe(`POST ${ENDPOINT}?sharecode=abc`);
    // RPC 失败是商家侧 500，不是访问配置问题。
    expect(results[0]?.failure?.classification).not.toBe("access_unavailable");
  });

  it("leaves ordinary merchants untouched", async () => {
    const calls: string[] = [];
    await fetcher(calls, { access: { sendUrlFor: (url) => `${url}?sharecode=abc` } }).requestQuotes(INTENT, [merchant(false)], CONTEXT);
    expect(calls[0]).toBe(`GET ${CARD}`);
    expect(calls[1]).toBe(`POST ${ENDPOINT}`);
  });

  it("fails closed when the catalog has no configuration for a WorkBuddy merchant", async () => {
    const calls: string[] = [];
    const results = await fetcher(calls, { access: null }).requestQuotes(INTENT, [merchant(true)], CONTEXT);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
    expect(results[0]?.failure?.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fails closed when no resolver is wired at all", async () => {
    const calls: string[] = [];
    const results = await fetcher(calls, { hasResolver: false }).requestQuotes(
      INTENT,
      [merchant(true)],
    );
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
    expect(calls).toHaveLength(0);
  });

  it("classifies a session rejection as access_unavailable, not protocol_error", async () => {
    const calls: string[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-buyer-access-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const failing = new A2AQuoteFetcher({
      fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch,
      skipDnsCheck: true,
      allowPrivateRanges: true,
      protocolStateDir: dir,
      localBuyerAgentId: "buyer-access-test",
      merchantAccess: {
        forMerchant: async () => {
          throw Object.assign(new Error("session rejected"), { code: "session_rejected" });
        },
        forEndpoint: async () => null,
      },
    });
    const results = await failing.requestQuotes(INTENT, [merchant(true)], CONTEXT);
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
    expect(results[0]?.failure?.detail).toContain("SESSION_REJECTED");
    expect(calls).toHaveLength(0);
  });

  it("never sends the standard Authorization header to a WorkBuddy merchant", async () => {
    const calls: string[] = [];
    const captured: Array<Record<string, string>> = [];
    await fetcher(calls, {
      access: { sendUrlFor: (url) => `${url}?sharecode=abc` },
      bearerToken: "bearer-should-not-be-sent",
      capture: captured,
    }).requestQuotes(INTENT, [merchant(true)], CONTEXT);
    const rpcHeaders = captured.find((headers) => headers["authorization"] !== undefined);
    expect(rpcHeaders).toBeUndefined();
  });

  it("keeps the bearer for ordinary merchants", async () => {
    const calls: string[] = [];
    const captured: Array<Record<string, string>> = [];
    await fetcher(calls, {
      access: { sendUrlFor: (url) => `${url}?sharecode=abc` },
      bearerToken: "bearer-ordinary",
      capture: captured,
    }).requestQuotes(INTENT, [merchant(false)], CONTEXT);
    expect(captured.some((headers) => headers["authorization"] === "Bearer bearer-ordinary")).toBe(
      true,
    );
  });

  it("signs outbound requests when a buyer signing identity is configured", async () => {
    const calls: string[] = [];
    const captured: Array<Record<string, string>> = [];
    const { generateA2aSigningIdentity } = await import("../src/a2a/signing-key.js");
    const { HttpMessageSigner } = await import("../src/trust/identity/index.js");
    const identity = generateA2aSigningIdentity("buyer.example");
    const signer = new HttpMessageSigner({
      keyid: identity.keyid,
      algorithm: identity.algorithm,
      privateKey: identity.privateKeyPem,
    });
    await fetcher(calls, {
      access: { sendUrlFor: (url) => `${url}?sharecode=abc` },
      signer,
      capture: captured,
    }).requestQuotes(INTENT, [merchant(true)], CONTEXT);
    // RPC 那条请求必须带 Signature（签名覆盖的是去码地址）。
    const signed = captured.find((headers) => headers["signature"] !== undefined);
    expect(signed).toBeDefined();
    expect(signed?.["signature-input"]).toContain("content-digest");
  });

  it("redacts a share parameter that a resolver error happened to carry", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-buyer-access-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const leaking = new A2AQuoteFetcher({
      fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch,
      skipDnsCheck: true,
      allowPrivateRanges: true,
      protocolStateDir: dir,
      localBuyerAgentId: "buyer-access-test",
      merchantAccess: {
        forMerchant: async () => {
          throw new Error("lookup failed at https://merchant.example/a2a?sharecode=SECRET-42");
        },
        forEndpoint: async () => null,
      },
    });
    const results = await leaking.requestQuotes(INTENT, [merchant(true)], CONTEXT);
    expect(results[0]?.failure?.detail ?? "").not.toContain("SECRET-42");
    expect(results[0]?.failure?.detail ?? "").toContain("sharecode=<redacted>");
  });
});
