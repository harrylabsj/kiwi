/**
 * Merchant 报价交期测试（V2 §8.5 P0-1）：
 * - 配置 merchant_policy.delivery_lead_days 时，offer/counter/conditional 的
 *   terms 含「报价时间 + 天数」动态计算的 delivery_before（不会过期）；
 * - 未配置时 terms 省略 fulfillment_terms.delivery_before（明确未知），
 *   clarification 应答不含具体日期、提示与商家确认；
 * - 任何路径都不得再出现静态/过期日期（2026-08-20 硬编码已移除）。
 *
 * 确定性：临时 Ledger + 注入时钟。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NegotiationHandler, NegotiationHandlerResult } from "../src/a2a/server/types.js";
import {
  createMerchantHandler,
  resolveDeliveryBefore,
} from "../src/a2a/server/merchant-handler.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = "2026-09-14T10:00:00Z";
const NEGOTIATION_ID = "neg_delivery_p0";
const MERCHANT_CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";
/** 硬编码静态交期（已移除）——任何输出都不得再包含它。 */
const REMOVED_STATIC_DATE = "2026-08-20";

let dir: string;
let ledger: LedgerStore;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kiwi-delivery-p0-"));
  ledger = new LedgerStore({ dir, now: () => NOW });
  seq = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeHandler(deliveryLeadDays?: number): NegotiationHandler {
  return createMerchantHandler({
    ledger,
    now: () => NOW,
    sender: "merchant:merchant-001",
    counterparty: "buyer:*",
    ...(deliveryLeadDays !== undefined
      ? { merchantPolicy: { delivery_lead_days: deliveryLeadDays } }
      : {}),
  });
}

function env(action: string, payload: Record<string, unknown>): NegotiationEnvelope {
  seq += 1;
  return finalizeEnvelope({
    capability: MERCHANT_CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: NEGOTIATION_ID,
    exchange_id: `ex_${seq}`,
    message_id: `msg_${seq}`,
    in_reply_to: `msg_${seq - 1}`,
    actor: "buyer",
    action: action as NegotiationEnvelope["action"],
    created_at: NOW,
    payload: payload as never,
  });
}

const runWith = (
  h: NegotiationHandler,
  envelope: NegotiationEnvelope,
): Promise<NegotiationHandlerResult> =>
  h.handle({
    envelope: envelope as never,
    message: { role: "user", parts: [], messageId: envelope.message_id },
    taskId: `task_${envelope.message_id}`,
    senderIdentity: "buyer:buyer-001",
  });

/** 从 handler 回复提取 knp_envelope。 */
function knpEnvelopeOf(result: NegotiationHandlerResult): Record<string, unknown> {
  const env = (
    result.kind === "accepted" && result.message
      ? (
          result.message.parts[0] as unknown as {
            data?: { knp_envelope?: Record<string, unknown> };
          }
        ).data?.knp_envelope
      : undefined
  ) as Record<string, unknown> | undefined;
  expect(env).toBeDefined();
  return env as Record<string, unknown>;
}

/** rfq → offer，返回 offer terms。 */
async function offerTermsOf(h: NegotiationHandler): Promise<Record<string, unknown>> {
  const result = await runWith(
    h,
    env("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }),
  );
  const reply = knpEnvelopeOf(result);
  expect(reply.action).toBe("offer");
  const terms = (reply.payload as { terms?: Record<string, unknown> }).terms;
  expect(terms).toBeDefined();
  return terms as Record<string, unknown>;
}

describe("resolveDeliveryBefore", () => {
  it("配置 lead days → now + 天数；未配置 → undefined", () => {
    expect(resolveDeliveryBefore({ delivery_lead_days: 7 }, NOW)).toBe(
      new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString(),
    );
    expect(resolveDeliveryBefore({}, NOW)).toBeUndefined();
    expect(resolveDeliveryBefore(undefined, NOW)).toBeUndefined();
  });
});

describe("merchant 报价交期（P0-1）", () => {
  it("配置 delivery_lead_days：offer terms 含 now+lead 的动态交期", async () => {
    const terms = await offerTermsOf(makeHandler(7));
    expect(terms.fulfillment_terms).toEqual({
      delivery_before: new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString(),
    });
  });

  it("未配置 delivery_lead_days：terms 省略 delivery_before（不报静态/过期日期）", async () => {
    const terms = await offerTermsOf(makeHandler());
    expect(terms.fulfillment_terms).toBeUndefined();
    expect(JSON.stringify(terms)).not.toContain("delivery_before");
    expect(JSON.stringify(terms)).not.toContain(REMOVED_STATIC_DATE);
  });

  it("clarification 应答：配置 lead days 时报动态日期", async () => {
    const h = makeHandler(10);
    await offerTermsOf(h); // OFFER_OPEN
    const result = await runWith(
      h,
      env("clarification", { questions: [{ field: "delivery_before" }] }),
    );
    const reply = knpEnvelopeOf(result);
    expect(reply.action).toBe("clarification_response");
    const expected = new Date(Date.parse(NOW) + 10 * 86_400_000).toISOString();
    expect(String(reply.public_message)).toContain(`delivery before ${expected}`);
    expect(JSON.stringify(reply)).not.toContain(REMOVED_STATIC_DATE);
  });

  it("clarification 应答：未配置时提示与商家确认，不含硬编码日期", async () => {
    const h = makeHandler();
    await offerTermsOf(h); // OFFER_OPEN
    const result = await runWith(
      h,
      env("clarification", { questions: [{ field: "delivery_before" }] }),
    );
    const reply = knpEnvelopeOf(result);
    expect(reply.action).toBe("clarification_response");
    expect(String(reply.public_message)).toContain("to be confirmed with the merchant");
    expect(JSON.stringify(reply)).not.toContain("delivery before 20");
    expect(JSON.stringify(reply)).not.toContain(REMOVED_STATIC_DATE);
  });
});
