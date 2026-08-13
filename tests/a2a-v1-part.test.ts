/**
 * A2A v1 Part 编解码测试（issue 04，高风险点）：
 * 0.3↔1.0 往返**无损**契约测试——KNP envelope / agreement 载荷必须在两种
 * Part 形状间逐字段一致（磋商内核 100% 复用，只转传输帧）。
 */
import { describe, expect, it } from "vitest";
import { decodeV1Part, encodeV1Part, isKnpDataPart } from "../src/a2a/v1/part.js";
import type { A2AV1Part } from "../src/a2a/v1/types.js";
import type { A2APart } from "../src/a2a/client/types.js";

/** 真实形状的 KNP envelope（RFQ）。 */
const KNP_RFQ_ENVELOPE = {
  capability: "com.harrylabsj.kiwi.shopping.negotiation",
  protocol_version: "1.0",
  negotiation_id: "neg_001",
  exchange_id: "ex_001",
  message_id: "msg_001",
  actor: "buyer",
  action: "rfq",
  created_at: "2026-08-13T00:00:00Z",
  payload: {
    type: "rfq",
    items: [{ sku: "VQ-003", quantity: { value: 1, unit: "piece" } }],
    requested_terms: { delivery_before: "2026-08-20T18:00:00Z" },
  },
};

function roundtrip(legacy: A2APart): A2APart {
  return decodeV1Part(encodeV1Part(legacy));
}

describe("A2A v1 Part（issue 04）", () => {
  it("text 往返无损", () => {
    const legacy: A2APart = { kind: "text", text: "你好，价格能谈吗？" };
    expect(roundtrip(legacy)).toEqual(legacy);
  });

  it("KNP RFQ DataPart 往返无损（逐字段一致）", () => {
    const legacy: A2APart = { kind: "data", data: { knp_envelope: KNP_RFQ_ENVELOPE } };
    const v1 = encodeV1Part(legacy);
    // 1.0 形状：统一 DataPart + mediaType
    expect("data" in v1).toBe(true);
    if (!("data" in v1)) return;
    expect(v1.mediaType).toBe("application/json");
    // 往返：字节级一致（JSON.stringify 相同）
    expect(roundtrip(legacy)).toEqual(legacy);
    expect(JSON.stringify(roundtrip(legacy))).toBe(JSON.stringify(legacy));
  });

  it("agreement DataPart 往返无损", () => {
    const agreement = { agreement_id: "agr_001", terms_digest: "sha256:abc", sku: "VQ-003", deal_price_minor: 899900 };
    const legacy: A2APart = { kind: "data", data: { agreement } };
    expect(roundtrip(legacy)).toEqual(legacy);
  });

  it("isKnpDataPart 识别 knp_envelope / agreement，拒绝其他 Part", () => {
    const knp: A2AV1Part = { data: { knp_envelope: KNP_RFQ_ENVELOPE }, mediaType: "application/json" };
    const aggr: A2AV1Part = { data: { agreement: { agreement_id: "a" } } };
    const text: A2AV1Part = { text: "hi" };
    const url: A2AV1Part = { url: "https://x.example/f" };
    expect(isKnpDataPart(knp)).toBe(true);
    expect(isKnpDataPart(aggr)).toBe(true);
    expect(isKnpDataPart(text)).toBe(false);
    expect(isKnpDataPart(url)).toBe(false);
  });

  it("URL/File Part 在 0.3 模型无等价 → decode fail-closed", () => {
    expect(() => decodeV1Part({ url: "https://x.example/f" } as A2AV1Part)).toThrow();
    expect(() => decodeV1Part({ raw: "aGk=", mediaType: "text/plain" } as A2AV1Part)).toThrow();
  });
});
