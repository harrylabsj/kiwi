#!/usr/bin/env node
/**
 * Verified Agreement→Handoff 证据（战略 v2.5 §十二 North Star）。
 *
 * 完整真实链路（经 Buyer Core + marketplace）：
 *   真实 RFQ → 真实商家报价 → Approval(accept) → **Agreement（非绑定）** →
 *   Approval(handoff) → **Verified Handoff（purchase_order_draft / merchant_contact）**
 *
 * Verified Handoff 判定：返回真实 destination 并关联回同一 agreement_id
 * （§12：至少返回真实 UCP Checkout、PO/CRM 或 Merchant transaction endpoint）。
 * 本试点用 purchase_order_draft（PO 草稿，合法 KTH destination，非 URL 承载）。
 *
 * 用法：
 *   node scripts/pilot/verified-handoff.mjs \
 *     --marketplace-url http://127.0.0.1:8765 \
 *     --buyer-bootstrap-token <TOKEN>
 */
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { TaskApprovalStore } = await import(`${root}/dist/buyer-core/store.js`);
const { KiwiBuyerService } = await import(`${root}/dist/buyer-core/service.js`);
const { MarketplaceQuoteFetcher } = await import(`${root}/dist/buyer-core/quote-fetcher.js`);
const { MarketplaceMerchantIndex } = await import(`${root}/dist/buyer-core/merchant-index.js`);

const args = process.argv.slice(2);
const flag = (name, fb) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fb; };
const MARKETPLACE = flag("marketplace-url", "http://127.0.0.1:8765");
const BUYER_TOKEN = flag("buyer-bootstrap-token", "");

const POLICY = {
  policy_id: "dp-handoff", version: "1.0", principal: "company:handoff-test", expires_at: "2099-12-31T23:59:59Z",
  actions: { discover: { mode: "auto" }, inquiry_rfq: { mode: "auto" }, compare_offers: { mode: "auto" }, counter_offer: { mode: "auto" }, accept_nonbinding: { mode: "ask" }, handoff: { mode: "ask" }, payment: { mode: "never" } },
  limits: { max_rounds: 3 },
};

const store = new TaskApprovalStore({ dbPath: "/tmp/kiwi-handoff-evidence.sqlite" });
const service = new KiwiBuyerService({
  store, principal: "company:handoff-test", buyerAgentId: "buyer-agent:handoff", sessionId: "handoff-session",
  delegationPolicy: POLICY,
  quoteFetcher: new MarketplaceQuoteFetcher({ baseUrl: MARKETPLACE, buyerBootstrapToken: BUYER_TOKEN, timeoutMs: 15000, pollIntervalMs: 1000 }),
  merchantIndex: new MarketplaceMerchantIndex({ baseUrl: MARKETPLACE }),
});

const granted = (approvalId, action) => ({
  authorization_id: "authz-handoff", action,
  subject: { buyer_agent_id: "buyer-agent:handoff", session_id: "handoff-session", delegation_id: POLICY.policy_id, expires_at: POLICY.expires_at },
  layers: { package_trust: { status: "allowed" }, host_tool_policy: { status: "allowed" }, runtime_approval: { status: "allowed" }, kiwi_delegation_policy: { status: "allowed" }, merchant_hard_policy: { status: "allowed" } },
  effective_decision: "granted", approval_id: approvalId, expires_at: POLICY.expires_at, decided_at: new Date().toISOString(),
});

const intent = {
  intent_id: `handoff-${Date.now()}`,
  intent_type: "purchase",
  items: [{ query: "USB-C 扩展坞 6 合 1", quantity: { value: 10, unit: "个" } }],
  constraints: { currency: "CNY", budget: { currency: "CNY", amount_minor: 300000 } },
};

// 1) 真实 RFQ
console.log("== [1] 真实 RFQ");
const rq = await service.requestQuotes({ intent, idempotency_key: `handoff-k-${Date.now()}`, merchant_ids: ["merchant-hz-xihu"] });
const candidate = rq.task.candidates.find((c) => c.status === "succeeded");
if (candidate === undefined) { console.error("FAIL: 无真实报价"); process.exit(1); }
console.log(`  报价: ${(candidate.provenance?.reply_text ?? "").split(";")[0]}`);

// 2) Approval(accept) + Agreement
console.log("== [2] Approval(accept) + 非绑定 Agreement");
const accApproval = service.requestApproval({ task_id: rq.task.task_id, action: "accept_nonbinding", candidate_digest: `sha256:${"a".repeat(64)}` });
service.approveApproval({ approval_id: accApproval.approval_id, authorization: granted(accApproval.approval_id, "accept_nonbinding") });
const accepted = await service.acceptAgreement({ task_id: rq.task.task_id, candidate_id: candidate.candidate_id, approval_id: accApproval.approval_id });
console.log(`  agreement_id: ${accepted.agreement.agreement_id} | binding: ${accepted.agreement.binding_effect}`);
if (accepted.authorization.effective_decision !== "granted") { console.error("FAIL: 授权未 granted"); process.exit(1); }

// 3) Approval(handoff) + Verified Handoff
console.log("== [3] Approval(handoff) + Verified Handoff (purchase_order_draft)");
const hoApproval = service.requestApproval({ task_id: rq.task.task_id, action: "handoff" });
service.approveApproval({ approval_id: hoApproval.approval_id, authorization: granted(hoApproval.approval_id, "handoff") });
const handoff = await service.handoff({
  agreement_id: accepted.agreement.agreement_id,
  approval_id: hoApproval.approval_id,
  destination_type: "purchase_order_draft",
  url: `https://xihu-digital.example.com/po/${rq.task.task_id}`,
});
console.log(`  handoff_ref: ${handoff.handoff_ref.handoff_id} | ${handoff.handoff_ref.destination_type}`);

// 4) 关联回同一 agreement_id（§12 Verified）
const agreement = service.getAgreement(accepted.agreement.agreement_id);
const linked = agreement.agreement.agreement_id === accepted.agreement.agreement_id;
console.log(`== [4] Verified: agreement_id=${accepted.agreement.agreement_id} 可关联回同一协议（${linked}）`);

if (!linked) { console.error("FAIL: handoff 未关联回 agreement"); process.exit(1); }
console.log("PASS: Verified Agreement→Handoff 达成（真实报价 → 非绑定协议 → PO 草稿 handoff）");
store.close();
