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
 * I-04 的离线等价物：Buyer 经"WorkBuddy 网关"访问真实 merchant 栈。
 *
 * 网关行为按 2026-10-27 的实测证据建模：缺码/错码 403；正确码放行并**从
 * 转发目标里剥除** sharecode；商家看到的是不带码的地址。
 *
 * 覆盖：agent card GET 与 A2A RPC 都经过网关且都带码；配置缺失/错误码时
 * fail-closed（不静默无码直连）。
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startTestA2aStack } from "./helpers.js";
import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import type { MerchantRecord } from "../src/buyer-core/service.js";
import { contentDigest } from "../src/negotiation/jcs.js";

const GATE_CODE = "gate-code-1";
const INTENT = {
  intent_id: "intent-e2e-1",
  intent_type: "purchase",
  items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 2, unit: "台" } }],
  constraints: { currency: "CNY", deadline: new Date(Date.now() + 86_400_000).toISOString() },
};
const CONTEXT = {
  taskId: "task-e2e-1",
  createdAt: new Date().toISOString(),
  intentBindingDigest: contentDigest(INTENT),
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Gateway {
  url: string;
  /** 每次经网关的请求：路径与是否带码（不带码的直接 403，不转发）。 */
  readonly seen: Array<{ path: string; gated: boolean }>;
  stop(): Promise<void>;
}

/** 模拟 WorkBuddy 网关：验码 → 剥码 → 转发到 merchant。 */
async function startGateway(merchantUrl: string, code: string): Promise<Gateway> {
  const seen: Array<{ path: string; gated: boolean }> = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const incoming = new URL(req.url ?? "/", "http://gateway.internal");
    const provided = incoming.searchParams.get("sharecode");
    seen.push({ path: incoming.pathname, gated: provided !== null });
    if (provided !== code) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "share code required" }));
      return;
    }
    incoming.searchParams.delete("sharecode");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const target = new URL(merchantUrl);
      // 测试脚手架：真实环境的商家公网 origin 就是 WorkBuddy 主机，这里网关与
      // 商家是不同 origin，所以把买方按网关 origin 派生的扩展 URI 换回商家口径。
      const gatewayOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const forwardHeaders: Record<string, unknown> = { ...req.headers };
      for (const [name, value] of Object.entries(forwardHeaders)) {
        if (typeof value === "string" && value.includes(gatewayOrigin)) {
          forwardHeaders[name] = value.split(gatewayOrigin).join(merchantUrl.replace(/\/$/, ""));
        }
      }
      function createServerRequest(): import("node:http").ClientRequest {
        return httpRequest(
          {
            hostname: target.hostname,
            port: target.port,
            path: incoming.pathname + incoming.search,
            method: req.method,
            headers: { ...forwardHeaders, host: target.host, "content-length": String(body.length) },
          },
          (upstreamRes: IncomingMessage) => {
            const upstreamChunks: Buffer[] = [];
            upstreamRes.on("data", (chunk: Buffer) => upstreamChunks.push(chunk));
            upstreamRes.on("end", () => {
              const payload = Buffer.concat(upstreamChunks);
              // 商家名片会把自身 origin 暴露给买方；WorkBuddy 下它的公网 origin
              // 就是网关，这里做等价改写（否则买方会绕过网关直连商家）。
              const rewritten = payload.toString("utf8").split(merchantUrl.replace(/\/$/, "")).join(
                `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
              );
              const out = Buffer.from(rewritten, "utf8");
              res.writeHead(upstreamRes.statusCode ?? 502, {
                "content-type": upstreamRes.headers["content-type"] ?? "application/json",
                "content-length": String(out.length),
              });
              res.end(out);
            });
          },
        );
      }
      const upstream = createServerRequest();
      upstream.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      upstream.end(body);
    });
  });
  cleanups.push(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function setup(options: { code?: string } = {}) {
  const stack = await startTestA2aStack({
    now: () => new Date().toISOString(),
    productSource: {
      getProduct: async () => ({
        price: 189,
        currency: "CNY",
        title: "Test Product",
        stock: 120,
        unit: "台",
        source_evidence: { system: "owned-test-fixture" },
      }),
    },
  });
  cleanups.push(() => void stack.stop());
  const gateway = await startGateway(stack.merchantUrl, options.code ?? GATE_CODE);
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-e2e-access-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const merchant: MerchantRecord = {
    merchant_id: "mkt_gate",
    name: "Gated Merchant",
    verified: true,
    capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"],
    agent_card_url: `${gateway.url}/.well-known/agent-card.json`,
    catalog_agent_id: "cagt_gate",
    runtime_access: {
      provider: "workbuddy",
      access_mode: "share_parameter",
      parameter_name: "sharecode",
      config_version: 1,
      adapter_version: "workbuddy-share-v1",
      auth_mode: "signature",
    },
  };
  return { stack, gateway, dir, merchant };
}

function fetcher(dir: string, code: string | null): A2AQuoteFetcher {
  return new A2AQuoteFetcher({
    protocolStateDir: dir,
    localBuyerAgentId: "buyer-e2e",
    allowPrivateRanges: true,
    skipDnsCheck: true,
    pollIntervalMs: 50,
    timeoutMs: 4000,
    ...(code === null
      ? {}
      : {
          merchantAccess: {
            forMerchant: async () => ({
              sendUrlFor: (url: string) => `${url}${url.includes("?") ? "&" : "?"}sharecode=${code}`,
            }),
            forEndpoint: async () => ({
              sendUrlFor: (url: string) => `${url}${url.includes("?") ? "&" : "?"}sharecode=${code}`,
            }),
          },
        }),
  });
}

describe("WorkBuddy gateway end-to-end (offline)", () => {
  it("carries the code through card discovery and the RFQ exchange", async () => {
    const { gateway, dir, merchant } = await setup();
    const results = await fetcher(dir, GATE_CODE).requestQuotes(INTENT, [merchant], CONTEXT);
    expect(results[0]?.status).toBe("succeeded");
    expect(results[0]?.provenance?.source).toBe("a2a");
    // 网关看到的两条请求都带码：card 读与 RPC。
    expect(gateway.seen.filter((entry) => entry.gated).length).toBeGreaterThanOrEqual(2);
    expect(gateway.seen.some((entry) => entry.path.includes("agent-card.json"))).toBe(true);
  });

  it("blocks the buyer when the code is wrong, without pretending the merchant refused", async () => {
    const { dir, merchant } = await setup({ code: "correct-code" });
    const results = await fetcher(dir, "wrong-code").requestQuotes(INTENT, [merchant], CONTEXT);
    expect(results[0]?.status).toBe("failed");
    // 平台门禁拒绝要与"商家拒绝报价"分开，且不盲目重发（B-07）。
    expect(results[0]?.failure?.classification).toBe("access_denied");
    expect(results[0]?.failure?.retryable).toBe(false);
    const detail = results[0]?.failure?.detail ?? "";
    expect(detail).toContain("HTTP 403");
    expect(detail).not.toMatch(/商家.*拒绝|merchant refused/i);
  });

  it("does not silently call the merchant without a code", async () => {
    const { gateway, dir, merchant } = await setup();
    const results = await fetcher(dir, null).requestQuotes(INTENT, [merchant], CONTEXT);
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
    expect(gateway.seen).toHaveLength(0);
  });
});
