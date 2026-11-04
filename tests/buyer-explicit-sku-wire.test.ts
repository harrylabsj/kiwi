/**
 * 隔离 A2A wire 回归：商家在 offer 中换 SKU 时，明确 SKU 的 RFQ 必须拒绝。
 * 使用本机真实 A2A server，不访问生产、不读取凭据。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTestA2aStack } from "./helpers.js";
import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { contentDigest } from "../src/negotiation/jcs.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-sku-wire-"));
  dirs.push(dir);
  return dir;
}

describe("explicit SKU A2A wire guard", () => {
  it("rejects a real offer for another SKU, while fuzzy intent still accepts merchant choice", async () => {
    const dir = temp();
    const now = new Date().toISOString();
    const sentSkus: string[] = [];
    let returnMismatch = true;
    const stack = await startTestA2aStack({
      now: () => now,
      handler: {
        name: "sku-mismatch-fixture",
        async handle(ctx) {
          const request = (ctx as {
            envelope: {
              capability: string;
              negotiation_id: string;
              message_id: string;
              payload?: { items?: Array<{ sku?: string }> };
            };
          }).envelope;
          const requestedSku = request.payload?.items?.[0]?.sku ?? "";
          sentSkus.push(requestedSku);
          const offeredSku =
            returnMismatch && requestedSku === "requested-sku" ? "other-sku" : requestedSku;
          const offer = finalizeEnvelope({
            capability: request.capability,
            protocol_version: "1.0",
            negotiation_id: request.negotiation_id,
            exchange_id: "ex_sku_wire",
            message_id: "msg_offer_other_sku",
            in_reply_to: request.message_id,
            actor: "merchant",
            action: "offer",
            created_at: now,
            payload: {
              type: "offer",
              offer_id: "off_other_sku",
              terms: {
                items: [
                  {
                    sku: offeredSku,
                    quantity: { value: 2, unit: "盒" },
                    unit_price: { currency: "CNY", amount_minor: 7000 },
                  },
                ],
                valid_until: "2099-12-31T23:59:59Z",
              },
            },
          });
          return {
            kind: "accepted",
            taskState: "working",
            message: {
              role: "agent",
              parts: [{ kind: "data", data: { knp_envelope: offer } }],
              messageId: offer.message_id,
            },
          } as never;
        },
      },
    });
    try {
      const merchant = {
        merchant_id: "merchant-1",
        name: "fixture",
        verified: true,
        capabilities: [],
        agent_card_url: `${stack.merchantUrl}/.well-known/agent-card.json`,
        // The target SKU is present, but another SKU is first. Explicit
        // requests must still use the target; fuzzy requests may use first.
        matching_skus: ["other-sku", "requested-sku"],
      };
      const options = {
        allowPrivateRanges: true,
        skipDnsCheck: true,
        timeoutMs: 3000,
        pollIntervalMs: 20,
        protocolStateDir: path.join(dir, "protocol"),
        localBuyerAgentId: "buyer-wire",
      };
      const explicitIntent = {
        intent_id: "wire-explicit",
        intent_type: "inquiry",
        items: [{ query: "测试商品", sku: "requested-sku", quantity: { value: 2, unit: "盒" } }],
      };
      const context = {
        taskId: "wire-task",
        createdAt: now,
        intentBindingDigest: contentDigest(explicitIntent),
      };
      const explicit = await new A2AQuoteFetcher(options).requestQuotes(
        explicitIntent,
        [merchant],
        context,
      );
      expect(explicit[0]?.status).toBe("failed");
      expect(explicit[0]?.failure?.detail).toBe("sku_mismatch");
      expect(sentSkus[0]).toBe("requested-sku");

      returnMismatch = false;
      const exact = await new A2AQuoteFetcher(options).requestQuotes(
        { ...explicitIntent, intent_id: "wire-exact" },
        [merchant],
        {
          ...context,
          taskId: "wire-task-exact",
          intentBindingDigest: contentDigest({ ...explicitIntent, intent_id: "wire-exact" }),
        },
      );
      expect(exact[0]?.status).toBe("succeeded");
      expect(sentSkus[1]).toBe("requested-sku");
      expect(exact[0]?.terms?.items?.[0]?.sku).toBe("requested-sku");

      const fuzzyIntent = {
        intent_id: "wire-fuzzy",
        intent_type: "inquiry",
        items: [{ query: "测试商品", quantity: { value: 2, unit: "盒" } }],
      };
      const fuzzy = await new A2AQuoteFetcher(options).requestQuotes(
        fuzzyIntent,
        [merchant],
        { ...context, taskId: "wire-task-fuzzy", intentBindingDigest: contentDigest(fuzzyIntent) },
      );
      expect(fuzzy[0]?.status).toBe("succeeded");
      expect(sentSkus[2]).toBe("other-sku");
      expect(fuzzy[0]?.terms?.items?.[0]?.sku).toBe("other-sku");
    } finally {
      await stack.stop();
    }
  });
});
