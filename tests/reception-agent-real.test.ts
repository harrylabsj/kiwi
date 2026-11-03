/**
 * M6：真实 provider 的 Pi 接待冒烟（opt-in）。
 *
 *   KIWI_RECEPTION_REAL_E2E=1 DEEPSEEK_API_KEY=... \
 *   npx vitest run tests/reception-agent-real.test.ts
 *
 * 只验证“生产路径能跑通并输出事实”，不替代 Q15 分层评分。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPiReceptionRuntime } from "../src/a2a/reception/agent-runtime.js";
import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import { buildModel, realStreamFn } from "../src/runtime/model.js";
import { testProfile } from "./helpers.js";

const ENABLED =
  process.env.KIWI_RECEPTION_REAL_E2E === "1" && (process.env.DEEPSEEK_API_KEY ?? "") !== "";
const NOW = "2026-11-03T04:00:00.000Z";

describe.skipIf(!ENABLED)("Pi reception real provider smoke (M6)", () => {
  it("真实模型经工具循环回答公开价格", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-agent-real-"));
    try {
      const profile = testProfile({
        model: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          api_key_env: "DEEPSEEK_API_KEY",
        },
      });
      const engine = createMerchantReceptionEngine({
        store: new ReceptionConversationStore({
          file: join(dir, "c.json"),
          now: () => NOW,
        }),
        outbox: new ReceptionReplyOutbox({ file: join(dir, "o.json"), now: () => NOW }),
        productSource: {
          async searchProducts() {
            return [{ sku: "VQ-001", title: "办公款", price: 110, currency: "CNY", stock: 50 }];
          },
          async getProduct() {
            return { price: 110, currency: "CNY", stock: 50, unit: "piece" };
          },
        },
        policy: () => ({
          price_floors: { "VQ-001": 100 },
          max_auto_discount_percent: 5,
          delivery_lead_days: 7,
        }),
        agent: createPiReceptionRuntime({
          streamFn: realStreamFn(),
          model: buildModel(profile),
          productSource: {
            async searchProducts() {
              return [{ sku: "VQ-001", title: "办公款", price: 110, currency: "CNY", stock: 50 }];
            },
            async getProduct() {
              return { price: 110, currency: "CNY", stock: 50, unit: "piece" };
            },
          },
          policy: () => ({
            price_floors: { "VQ-001": 100 },
            max_auto_discount_percent: 5,
            delivery_lead_days: 7,
          }),
          getApiKey: () => process.env.DEEPSEEK_API_KEY,
          maxSteps: 8,
          maxToolAttempts: 12,
          timeoutMs: 30_000,
        }),
        now: () => NOW,
      });
      const result = await engine.respond({
        merchantId: "merchant-1",
        identity: "buyer:1",
        identityVerified: false,
        contextId: "ctx_real_agent",
        text: "VQ-001 两盒多少钱？",
        now: NOW,
        messageId: "msg_real_agent",
      });
      expect(result.text).toContain("110.00 CNY");
      expect(result.text).not.toContain("100.00");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
