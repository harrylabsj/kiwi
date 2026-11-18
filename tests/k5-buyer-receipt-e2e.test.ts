/**
 * 买家识别与交易回执 · K5 买方侧回执上报端到端。
 *
 * 复用 startTestA2aStack 全栈：真实 RFQ → counter → accept → 本地协议提交
 * （含 merchant_agreement）→ buyer_agreement_accepted 回执经 outbox 投递到
 * 桩 Catalog（捕获 POST /v1/commerce/receipts）。纯本地候选（无
 * merchant_agreement）不入队——由 merchant_agreement 存在性断言覆盖。
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { startTestA2aStack } from "./helpers.js";

const recoveryDirs: string[] = [];
const httpServers: http.Server[] = [];

afterEach(() => {
  for (const dir of recoveryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of httpServers.splice(0)) server.close();
});

/** 桩 Catalog：捕获回执 POST（merchant token / buyer JWS 都接受）。 */
async function startStubCatalog(): Promise<{ url: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(raw));
      } catch {
        bodies.push({});
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  httpServers.push(server);
  return { url: `http://127.0.0.1:${address.port}`, bodies };
}

describe("K5 买方意向回执端到端", () => {
  it("accept 成功提交本地协议后投递 buyer_agreement_accepted（经 outbox）", async () => {
    const { buildBuyerService } = await import("../src/buyer-core/build-service.js");
    const { buildKiwiTools } = await import("../src/mcp/tools.js");
    const { DEFAULT_DELEGATION_POLICY } = await import("../src/mcp/cli.js");
    const catalog = await startStubCatalog();
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 120, unit: "台", source_evidence: { system: "owned-test-fixture" } }),
      },
      merchantPolicy: { price_floors: { "sku-001": 180 }, max_auto_discount_percent: 5 },
    });
    const protocolDir = mkdtempSync(path.join(tmpdir(), "k5-buyer-"));
    recoveryDirs.push(protocolDir);
    const { loadOpenInquiryIdentity } = await import("../src/buyer-core/open-inquiry-signer.js");
    const signingIdentity = loadOpenInquiryIdentity(protocolDir, "hermes:probe", "buyer-agent:hermes");
    try {
      const service = buildBuyerService({
        dbPath: ":memory:",
        protocolStateDir: protocolDir,
        principal: "hermes:probe",
        buyerAgentId: "buyer-agent:hermes",
        sessionId: "e2e-receipt",
        policy: {
          ...DEFAULT_DELEGATION_POLICY,
          principal: "hermes:probe",
          actions: { ...DEFAULT_DELEGATION_POLICY.actions, accept_nonbinding: { mode: "auto" } },
        },
        catalogUrl: stack.catalogUrl,
        a2aAllowPrivateRanges: true,
        a2aSkipDnsCheck: true,
        a2aTimeoutMs: 8000,
        openInquiryDirect: true,
        commerceReceipts: {
          catalogUrl: catalog.url,
          publicKeyPem: signingIdentity.publicKeyPem,
          privateKeyPem: signingIdentity.privateKeyPem,
        },
      });
      const tools = buildKiwiTools(service);
      const call = (name: string, args: Record<string, unknown>) =>
        tools.find((t) => t.name === name)!.handle(args);
      const text = (r: { content?: Array<{ text?: string }> }) => r.content?.[0]?.text ?? "";
      const search = JSON.parse(text(await call("kiwi_search", { query: "Test Product" }))) as {
        merchants: Array<{ merchant_id: string }>;
      };
      const merchantId = search.merchants[0]!.merchant_id;
      const rq = await call("kiwi_request_quotes", {
        intent: {
          intent_id: "e2e-receipt-1",
          intent_type: "purchase",
          items: [{ query: "Test Product", quantity: { value: 1, unit: "台" } }],
          constraints: { currency: "CNY", budget: { currency: "CNY", amount_minor: 18000 } },
          context_projection: { disclosure_boundary: "commerce_required", projected_fields: ["items", "constraints"] },
        },
        merchant_ids: [merchantId],
      });
      expect(rq.isError).toBeUndefined();
      const taskId = (JSON.parse(text(rq)) as { task_id: string }).task_id;
      const negotiated = await call("kiwi_negotiate", {
        task_id: taskId,
        action: "counter_offer",
        summary: "预算上限 180 元",
      });
      expect(negotiated.isError).toBeUndefined();
      const taskAfter = JSON.parse(text(await call("kiwi_get_task", { task_id: taskId }))) as {
        task: { candidates: Array<{ candidate_id: string }> };
      };
      const candidate = taskAfter.task.candidates[0]!;
      const accepted = await call("kiwi_accept_agreement", { task_id: taskId, candidate_id: candidate.candidate_id });
      expect(accepted.isError).toBeUndefined();
      const result = JSON.parse(text(accepted)) as {
        agreement: {
          agreement_id: string;
          negotiation_id?: string;
          merchant_agreement?: Record<string, unknown>;
        };
      };
      expect(result.agreement.merchant_agreement).toBeDefined();
      // outbox 投递到桩 Catalog（异步）：轮询等待回执到达。
      const waitForReceipt = async (): Promise<Array<Record<string, unknown>>> => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const found = catalog.bodies.filter(
            (body) => body["event_type"] === "buyer_agreement_accepted",
          ) as Array<Record<string, unknown>>;
          if (found.length > 0) return found;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return [];
      };
      const receipts = await waitForReceipt();
      expect(receipts).toHaveLength(1);
      const receipt = receipts[0]!;
      expect(receipt["event_id"]).toBe(`buyer-agreement:${result.agreement.agreement_id}`);
      expect(receipt["merchant_id"]).toBe(merchantId);
      expect(receipt["merchant_agreement_id"]).toBe(
        String((result.agreement.merchant_agreement as Record<string, unknown>).agreement_id),
      );
      expect(typeof receipt["negotiation_id"]).toBe("string");
      expect(typeof receipt["accepted_offer_id"]).toBe("string");
      expect(typeof receipt["terms_digest"]).toBe("string");
      expect(receipt["protocol_version"]).toBe("1.0");
      expect(receipt).not.toHaveProperty("buyer_binding");
      expect(typeof receipt["buyer_signature"]).toBe("string");
    } finally {
      await stack.stop();
    }
  });
});
