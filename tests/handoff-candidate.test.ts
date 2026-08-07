/**
 * HandoffCandidate 测试（KTH rev0.3 §5；v0.7.0 完成定义 #9、#10）。
 *
 * 覆盖：
 * - 构造即校验：agreement 绑定、terms_digest 与 agreed_terms 重算一致性、
 *   destination 校验、三 false 不变量；
 * - 不可变性：构造后输入变更不泄漏（防御拷贝）；
 * - candidate_digest：自洽、篡改检测；
 * - 事件重建：validateHandoffCandidate 从 Ledger 事件内容重建且 digest 一致。
 */
import { describe, expect, it } from "vitest";
import {
  createHandoffCandidate,
  validateHandoffCandidate,
  verifyHandoffCandidateDigest,
  type HandoffCandidate,
} from "../src/handoff/index.js";
import { contentDigest } from "../src/negotiation/jcs.js";

const AGREED_TERMS = {
  items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" } }],
  price_terms: { currency: "CNY", amount_minor: 83500 },
};

function candidateInput(overrides: Record<string, unknown> = {}) {
  return {
    agreement_id: "agr_01JABC",
    negotiation_id: "neg_01JABC",
    agreed_terms: AGREED_TERMS,
    buyer_identity_ref: "principal:buyer-1",
    merchant_identity_ref: "merchant:acme",
    destination: {
      type: "external_checkout_url" as const,
      ref: "https://acme.example/checkout/abc",
    },
    display_summary: { merchant: "Acme Merchant", summary: "200 units, CNY 835.00/unit" },
    policy_version: "handoff-policy/1",
    expires_at: "2026-08-08T12:00:00Z",
    ...overrides,
  };
}

describe("createHandoffCandidate", () => {
  it("构造即校验：绑定 + digest + 三 false 不变量", () => {
    const candidate = createHandoffCandidate(candidateInput());
    expect(candidate.handoff_candidate_id).toMatch(/^hcan_/);
    expect(candidate.agreement_id).toBe("agr_01JABC");
    expect(candidate.negotiation_id).toBe("neg_01JABC");
    expect(candidate.terms_digest).toBe(contentDigest(AGREED_TERMS));
    expect(candidate.buyer_identity_ref).toBe("principal:buyer-1");
    expect(candidate.merchant_identity_ref).toBe("merchant:acme");
    expect(candidate.destination_type).toBe("external_checkout_url");
    expect(candidate.creates_order).toBe(false);
    expect(candidate.authorizes_payment).toBe(false);
    expect(candidate.reserves_inventory).toBe(false);
    expect(verifyHandoffCandidateDigest(candidate)).toBe(true);
  });

  it("terms_digest 与 agreed_terms 不一致 → 拒绝（fail-closed）", () => {
    expect(() =>
      createHandoffCandidate(
        candidateInput({ terms_digest: "sha256:deadbeef" }),
      ),
    ).toThrow(/terms_digest/);
  });

  it("显式 terms_digest 与 agreed_terms 一致 → 通过", () => {
    const digest = contentDigest(AGREED_TERMS);
    const candidate = createHandoffCandidate(candidateInput({ terms_digest: digest }));
    expect(candidate.terms_digest).toBe(digest);
  });

  it("缺少 terms_digest 且无 agreed_terms → 拒绝", () => {
    const { agreed_terms: _omit, ...rest } = candidateInput();
    expect(() => createHandoffCandidate({ ...rest } as never)).toThrow(/terms_digest/);
  });

  it("URL 类目的地要求 http(s) ref；会话类不要求", () => {
    expect(() =>
      createHandoffCandidate(
        candidateInput({ destination: { type: "external_checkout_url", ref: "javascript:alert(1)" } }),
      ),
    ).toThrow(/http/);
    const erp = createHandoffCandidate(
      candidateInput({ destination: { type: "buyer_erp_request", ref: "erp-request-42" } }),
    );
    expect(erp.destination_ref).toBe("erp-request-42");
  });

  it("未知 destination type → 拒绝", () => {
    expect(() =>
      createHandoffCandidate(
        candidateInput({ destination: { type: "supports_checkout", ref: "x" } }),
      ),
    ).toThrow(/unknown destination type/);
  });

  it("不可变性：构造后变更输入不泄漏进候选", () => {
    const input = candidateInput();
    const candidate = createHandoffCandidate(input);
    (input.display_summary as { summary: string }).summary = "HACKED";
    expect(candidate.display_summary.summary).toBe("200 units, CNY 835.00/unit");
    (input.destination as { ref: string }).ref = "https://evil.example/";
    expect(candidate.destination_ref).toBe("https://acme.example/checkout/abc");
    const candidate2 = createHandoffCandidate(candidateInput());
    expect(verifyHandoffCandidateDigest(candidate2)).toBe(true);
  });

  it("过期时间必须是 RFC 3339", () => {
    expect(() =>
      createHandoffCandidate(candidateInput({ expires_at: "not-a-timestamp" })),
    ).toThrow(/RFC 3339|timestamp/);
  });
});

describe("validateHandoffCandidate (Ledger 事件重建)", () => {
  it("从事件内容重建候选且 digest 一致", () => {
    const original = createHandoffCandidate(candidateInput());
    const rebuilt = validateHandoffCandidate({
      ...original,
      candidate_digest: undefined,
    });
    expect(rebuilt.handoff_candidate_id).toBe(original.handoff_candidate_id);
    expect(rebuilt.candidate_digest).toBe(original.candidate_digest);
    expect(verifyHandoffCandidateDigest(rebuilt)).toBe(true);
  });

  it("重建时三 false 被篡改为 true → 拒绝", () => {
    const original = createHandoffCandidate(candidateInput());
    const tampered = {
      ...original,
      creates_order: true,
      candidate_digest: "",
    } as unknown as HandoffCandidate;
    expect(() => validateHandoffCandidate(tampered)).toThrow(/三副作用不变量/);
  });

  it("重建时 digest 不匹配 → 拒绝（防篡改）", () => {
    const original = createHandoffCandidate(candidateInput());
    expect(() =>
      validateHandoffCandidate({ ...original, destination_ref: "https://evil.example/" }),
    ).toThrow(/digest mismatch/);
  });
});
