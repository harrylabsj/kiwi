import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCosts, type QuoteCosts } from "../src/buyer-core/procurement/quote-normalizer.js";
import { projectRequirements, REQUIREMENTS_KEY } from "../src/buyer-core/procurement/requirements.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { KiwiBuyerService } from "../src/buyer-core/service.js";
import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { A2ANegotiator } from "../src/buyer-core/a2a-negotiator.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { LedgerStore } from "../src/negotiation/ledger/store.js";
import { validateWireEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { envelopeToMessage } from "../src/buyer-core/a2a-knp.js";
import { DEFAULT_DELEGATION_POLICY } from "../src/mcp/cli.js";
import { buildKiwiTools } from "../src/mcp/tools.js";


const temp: string[] = [];
function freshDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-procurement-test-"));
  chmodSync(directory, 0o700);
  temp.push(directory);
  return realpathSync(directory);
}
afterEach(() => { for (const directory of temp.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const basis = {
  buyer_item_key: "line-1", description: "Test Product", model: "DEMO-65W", selection_mode: "exact_item" as const,
  quantity: 120, unit: "台", destination: "北京", delivery_before: new Date(Date.now() + 7 * 86400000).toISOString(),
  company: "INTERNAL-COMPANY",
  budget: { amount_minor: 1400000, scope: "total" as const, hardness: "hard" as const },
  requirements: [{ id: "warranty", kind: "warranty" as const, hardness: "hard" as const, value: 36, source: "user", disclose: true }],
};
const costs: QuoteCosts = {
  currency: "CNY", mode: "components", complete: true, quantity: 120, unit: "台", native_basis: "net",
  goods: { id: "goods", kind: "goods", amount_minor: 10000, scope: "per_unit", tax: "net", tax_bps: 1300 },
  charges: [{ id: "freight", kind: "freight", amount_minor: 12000, scope: "order", tax: "gross", included: false }],
};
function findWire(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  if ("knp_envelope" in value) return value.knp_envelope;
  return Object.values(value).map(findWire).find(wire => wire !== undefined);
}
function toolClient(service: KiwiBuyerService, opts?: { captureRoot?: string; confirm?: () => Promise<boolean> }) {
  const tools = buildKiwiTools(service, "company-procurement-v1", opts);
  const raw = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.handle(args);
  return {
    tools,
    raw,
    async call(name: string, args: Record<string, unknown>) {
      const result = await raw(name, args);
      expect(result.isError, result.content[0]?.text).toBeUndefined();
      return JSON.parse(result.content[0]!.text);
    },
  };
}

describe("company procurement cost and case integrity", () => {
  it("uses exact tax arithmetic, refuses conflicts and inapplicable deal quantities", () => {
    expect(normalizeCosts(costs, 120, "台").cash_total_minor).toBe(1368000);
    expect(normalizeCosts({ ...costs, complete: false, charges: [] }, 120, "台"))
      .toMatchObject({ known_amount_minor: 1356000, cash_total_minor: null });
    expect(normalizeCosts({ ...costs, total_minor: 1360000 }, 120, "台"))
      .toMatchObject({ cash_total_minor: null, conflicts: ["declared_total_disagrees"], stated_total_minor: 1360000 });
    expect(normalizeCosts({ ...costs, min_quantity: 1000 }, 120, "台"))
      .toMatchObject({ cash_total_minor: null, known_amount_minor: null });
    expect(normalizeCosts({ ...costs, charges: [], pack_multiple: 50,
      goods: { ...costs.goods!, tax: "gross", amount_minor: 10800 } }, 120, "台"))
      .toMatchObject({ cash_total_minor: null, scenario: { quantity: 150, extra: 30, cash_total_minor: 1620000 } });
  });

  it("persists all original request rows and versions, isolates owner and keeps legacy tools", async () => {
    const dbPath = join(freshDirectory(), "buyer.sqlite");
    const make = (sessionOwner: string) => {
      const store = new TaskApprovalStore({ dbPath });
      const service = new KiwiBuyerService({ store, principal: "company", buyerAgentId: "buyer", sessionId: "session",
        sessionOwner, delegationPolicy: DEFAULT_DELEGATION_POLICY });
      return { store, service, ...toolClient(service) };
    };
    const first = make("same-owner");
    expect(buildKiwiTools(first.service)).toHaveLength(13);
    expect(first.tools).toHaveLength(17);
    for (const suffix of ["", "-wal", "-shm"]) expect(statSync(dbPath + suffix).mode & 0o777).toBe(0o600);
    for (const name of ["kiwi_get_task", "kiwi_get_agreement", "kiwi_handoff"]) {
      const missing = await first.raw(name, {});
      expect(missing.isError).toBe(true);
      expect(missing.content[0]?.text).toContain("invalid_params");
    }
    const failure = vi.spyOn(first.service, "getTask").mockImplementationOnce(() => { throw new Error(dbPath); });
    expect((await first.raw("kiwi_get_task", { task_id: "example" })).content[0]?.text)
      .toBe("error internal_error: Tool operation failed");
    failure.mockRestore();
    expect((await first.raw("kiwi_prepare_procurement", { operation: "create", request_id: "invalid", basis, owner: "foreign" })).isError).toBe(true);
    const inputLines = ["one", "two", "three"].map(input_line_id => ({ input_line_id, raw: input_line_id }));
    const { group } = await first.call("kiwi_prepare_procurement", { operation: "register_group", request_id: "group-1", lines: inputLines });
    const create = { operation: "create", request_id: "case-1", basis, group_ref: { group_id: group.id, revision: group.revision, input_line_id: "one" } };
    const created = await first.call("kiwi_prepare_procurement", create);
    first.store.close();
    const next = make("same-owner");
    expect(await next.call("kiwi_prepare_procurement", create)).toEqual(created);
    const restored = await next.call("kiwi_get_procurement", { operation: "get_group", group_id: group.id });
    expect(restored.group.lines).toEqual([{ ...inputLines[0], case_id: created.case.id }, ...inputLines.slice(1)]);
    expect(await next.raw("kiwi_prepare_procurement", { ...create, basis: { ...basis, quantity: 12 } })).toMatchObject({ isError: true });
    const foreign = make("different-owner");
    expect(await foreign.raw("kiwi_get_procurement", { operation: "get", case_id: created.case.id })).toMatchObject({ isError: true });
    const cases = await foreign.call("kiwi_get_procurement", { operation: "list_recent", kind: "case" });
    expect(cases.items).toEqual([]);
    next.store.close();
    foreign.store.close();
  });
});

describe("company procurement through native A2A and external source capture", () => {
  it("compares real protocol offers with trusted material, re-asks only the bound merchant, and preserves history", async () => {
    const capture: NegotiationEnvelope[] = [];
    let months = 12;
    const directory = freshDirectory();
    const merchant = { merchant_id: "merchant-001", name: "Test Merchant", verified: true, capabilities: [],
      inquiry_available: true, matching_skus: ["sku-001"], agent_card_url: "https://merchant.example/card" };
    const handler = createMerchantHandler({
      ledger: new LedgerStore({ dir: join(directory, "merchant"), now: () => new Date().toISOString() }),
      sender: "merchant:merchant-001", counterparty: "buyer:*",
      now: () => new Date().toISOString(),
      productSource: { getProduct: async () => ({ price: 100, currency: "CNY", stock: 140, unit: "台",
        source_evidence: { system: "fixture", source_version: "v1" } }) },
      merchantPolicy: { delivery_lead_days: 2, price_floors: { "sku-001": 95 }, max_auto_discount_percent: 5 },
      procurementFacts: () => ({ version: `conditions-${months}`, model: "DEMO-65W", destination: "北京", values: { warranty: months },
        native_basis: "net", goods_tax_bps: 1300, freight: { included: false, amount_minor: 12000, tax: "gross" }, no_other_fees: true }),
    });
    let transportError: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      try {
      if (!init?.body) return Response.json({ supportedInterfaces: [{ protocolBinding: "JSONRPC", url: "https://merchant.example/rpc" }] });
      const body = JSON.parse(String(init.body)) as { id: string; method: string };
      const rawWire = findWire(body);
      if (!rawWire) throw new Error(`Unexpected fixture RPC ${body.method}`);
      const wire = validateWireEnvelope(rawWire);
      capture.push(wire);
      const taskId = `remote-task-${capture.length}`;
      const response = await handler.handle({ envelope: wire, message: envelopeToMessage(wire), taskId, senderIdentity: "buyer:company" });
      expect(response.kind).toBe("accepted");
      if (response.kind !== "accepted") throw new Error(JSON.stringify(response));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { task: { id: taskId, contextId: wire.negotiation_id,
        status: { state: "completed", message: response.message } } } });
      } catch (error) {
        transportError = error;
        throw error;
      }
    };
    const protocol = { protocolStateDir: join(directory, "buyer-protocol"), localBuyerAgentId: "buyer:company", skipDnsCheck: true, fetchImpl };
    const store = new TaskApprovalStore({ dbPath: join(directory, "buyer.sqlite") });
    try {
      const captureRoot = join(directory, "captures");
      mkdirSync(captureRoot, { mode: 0o700 });
      writeFileSync(join(captureRoot, "verified-b.json"), JSON.stringify({
        name: "Platform supplier", variant: "platform-sku-b", price_kind: "SUPPLIER_QUOTE",
        evidence: { reference: "[fixture-quote.pdf#page=1](example)", captured_at: new Date().toISOString(),
          valid_until: new Date(Date.now() + 3600000).toISOString() },
        product: { model: basis.model, values: { warranty: 36 }, supplier_ref: "verified-company-2", verified_kiwi_merchant_id: "merchant-001", stock_quantity: 120,
          arrived_by: new Date(Date.now() + 3 * 86400000).toISOString(), destination: "北京" },
        costs: { ...costs, native_basis: undefined, goods: { ...costs.goods, amount_minor: 11250, tax: "gross", tax_bps: undefined },
          charges: [{ ...costs.charges![0], amount_minor: 10000 }] },
      }), { mode: 0o600 });
      let confirm = false;
      let clockOffset = 0;
      const service = new KiwiBuyerService({ store, principal: "workbuddy-test", buyerAgentId: "buyer:company", sessionId: "company",
        now: () => new Date(Date.now() + clockOffset).toISOString(), delegationPolicy: DEFAULT_DELEGATION_POLICY, merchantIndex: { search: async () => [merchant], resolveById: async id => id === merchant.merchant_id ? merchant : undefined },
        quoteFetcher: new A2AQuoteFetcher(protocol), negotiator: new A2ANegotiator(protocol) });
      const { call, raw } = toolClient(service, { captureRoot, confirm: async () => confirm });
      const created = await call("kiwi_prepare_procurement", { operation: "create", request_id: "create", basis });
      const attached = await call("kiwi_prepare_procurement", { operation: "attach_sources", request_id: "sources",
        case_id: created.case.id, expected_revision: created.case.revision, ecommerce_status: "completed",
        sources: [{ id: "a", channel: "kiwi", variant: "sku-001", merchant_id: "merchant-001", query: "Test Product" },
          { id: "b", channel: "ecommerce", variant: "platform-sku-b", capture_id: "verified-b" }],
      });
      const args = { intent: { intent_id: "rfq-1", intent_type: "procurement",
        items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 120, unit: "台" } }] },
        merchant_ids: ["merchant-001"], idempotency_key: "first-rfq",
        procurement_ref: { case_id: attached.case.id, revision: attached.case.revision, source_binding_id: "a" } };
      expect(await raw("kiwi_request_quotes", { ...args, merchant_ids: ["merchant-001", "merchant-x"] })).toMatchObject({ isError: true });
      const expiring = { ...args, idempotency_key: "expired-before-reservation" };
      const expiringDraft = await call("kiwi_request_quotes", expiring);
      confirm = true;
      const expiredId = expiringDraft.approval_required.approval_id;
      await call("kiwi_approve", { approval_id: expiredId });
      vi.spyOn(store, "createTask").mockImplementationOnce(() => { throw new Error("interrupted"); });
      expect((await raw("kiwi_request_quotes", { ...expiring, approval_id: expiredId })).isError).toBe(true);
      clockOffset = 16 * 60_000;
      expect((await raw("kiwi_request_quotes", { ...expiring, approval_id: expiredId })).content[0]?.text).toContain("REVOKED");
      expect(capture).toHaveLength(0);
      clockOffset = 0;
      confirm = false;
      const draft = await call("kiwi_request_quotes", args);
      expect(capture).toHaveLength(0);
      const approvalId = draft.approval_required.approval_id;
      expect(await raw("kiwi_approve", { approval_id: approvalId })).toMatchObject({ isError: true });
      confirm = true;
      await call("kiwi_approve", { approval_id: approvalId });
      const approved = { ...args, approval_id: approvalId };
      // Stop between the authorization commit and the native task reservation.
      const reservation = vi.spyOn(store, "createTask").mockImplementationOnce(() => { throw new Error("interrupted"); });
      expect((await raw("kiwi_request_quotes", approved)).isError).toBe(true);
      reservation.mockRestore();
      expect(capture).toHaveLength(0);
      expect(service.companyProcurement().getAction(approvalId).status).toBe("IN_FLIGHT");
      await expect(service.requestProcurementQuotes({ ...approved, approval_id: "wrong" })).rejects.toThrow("APPROVAL_MISMATCH");
      // Older releases persisted UNKNOWN for the same pre-reservation failure.
      service.companyProcurement().completeAction(approvalId, "UNKNOWN", { status: "UNKNOWN" });
      const attempts = await Promise.all([call("kiwi_request_quotes", approved), call("kiwi_request_quotes", approved)]);
      const first = await call("kiwi_request_quotes", approved);
      expect(attempts.map(result => result.task_id)).toEqual([first.task_id, first.task_id]);
      expect(transportError).toBeUndefined();
      expect(first.task.status, JSON.stringify(first.task.candidates)).toBe("succeeded");
      expect(await call("kiwi_request_quotes", { ...args, approval_id: approvalId })).toEqual(first);
      expect(capture.map(event => event.action)).toEqual(["rfq"]);
      const wire = JSON.stringify(capture[0]);
      expect(wire).toContain(projectRequirements(basis).projection_digest);
      expect(wire).toContain(REQUIREMENTS_KEY);
      expect(wire).not.toContain("INTERNAL-COMPANY");
      expect(wire).not.toContain("1400000");
      const current = (await call("kiwi_get_procurement", { operation: "get", case_id: created.case.id })).case;
      const { snapshot } = await call("kiwi_compare_quotes", { operation: "create", request_id: "compare",
        case_ref: { case_id: current.id, revision: current.revision } });
      expect(snapshot.data.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ source_id: "a", price_kind: "KNP_OFFER", cash_total_minor: 1368000, group: "INCOMPLETE",
          requirements: [expect.objectContaining({ id: "warranty", confirmed: "NOT_MET", transmitted: "RECEIPTED" })] }),
        expect.objectContaining({ source_id: "b", price_kind: "SUPPLIER_QUOTE", cash_total_minor: 1360000, group: "CONFIRMED" }),
      ]));
      expect(snapshot.data.recommendation).toBe("b");
      expect(snapshot.csv).toContain("1360000");
      expect(snapshot.markdown).toContain("&#91;fixture-quote.pdf#page=1&#93;(example)");

      const action = { request_id: "clarification-1", task_id: first.task_id, candidate_id: first.task.candidates[0].candidate_id,
        expected_offer_digest: snapshot.data.rows[0].offer_digest, comparison_ref: { comparison_id: snapshot.id, revision: snapshot.revision },
        action: "clarification", questions: [{ field: "requirement:warranty:NOT_MET", reason: "internal cost center ACCT-789" }] };
      const clarification = await call("kiwi_negotiate", action);
      await call("kiwi_approve", { approval_id: clarification.approval_required.approval_id });
      const sent = await call("kiwi_negotiate", { ...action, approval_id: clarification.approval_required.approval_id });
      expect(sent.status).toBe("DONE");
      expect(JSON.stringify(capture[1])).toContain("requirement:warranty:NOT_MET");
      expect(JSON.stringify(capture[1])).not.toContain("ACCT-789");
      expect(capture.map(event => event.action)).toEqual(["rfq", "clarification"]);
      expect(await call("kiwi_negotiate", action)).toEqual(sent);

      months = 36;
      const requote = { ...args, idempotency_key: "re-quote-1", procurement_ref: { ...args.procurement_ref,
        revision: current.revision, replaces_source_id: "a" } };
      const requoteDraft = await call("kiwi_request_quotes", requote);
      await call("kiwi_approve", { approval_id: requoteDraft.approval_required.approval_id });
      const approvedRequote = { ...requote, approval_id: requoteDraft.approval_required.approval_id };
      vi.spyOn(store, "createTask").mockImplementationOnce(() => { throw new Error("interrupted"); });
      expect((await raw("kiwi_request_quotes", approvedRequote)).isError).toBe(true);
      const next = await call("kiwi_request_quotes", approvedRequote);
      expect(next.task_id).not.toBe(first.task_id);
      const later = (await call("kiwi_get_procurement", { operation: "get", case_id: current.id })).case;
      const refreshed = await call("kiwi_compare_quotes", { operation: "refresh", request_id: "refresh",
        comparison_id: snapshot.id, expected_revision: snapshot.revision, case_ref: { case_id: later.id, revision: later.revision } });
      expect(refreshed.snapshot.data.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ price_kind: "KNP_OFFER", cash_total_minor: 1368000, group: "CONFIRMED" }),
      ]));
      expect(refreshed.snapshot.data.independent_suppliers_confirmed).toBe(1);
      expect(refreshed.snapshot.data.rows.map((row: { source_id: string }) => row.source_id)).not.toContain("a");
      const previous = await call("kiwi_get_comparison", { comparison_id: snapshot.id, revision: snapshot.revision });
      expect(previous.snapshot).toEqual(snapshot);
      expect(capture.map(event => event.action)).toEqual(["rfq", "clarification", "rfq"]);
      const updatedQuote = refreshed.snapshot.data.rows.find((row: { price_kind: string }) => row.price_kind === "KNP_OFFER");
      const counter = { request_id: "explicit-counter", task_id: next.task_id, candidate_id: next.task.candidates[0].candidate_id,
        expected_offer_digest: updatedQuote.offer_digest, comparison_ref: { comparison_id: snapshot.id, revision: refreshed.snapshot.revision },
        action: "counter_offer", target_unit_price: { currency: "CNY", amount_minor: 9800, basis: "net" } };
      const pending = await call("kiwi_negotiate", counter);
      expect(pending.payload.proposed_terms.items[0].unit_price).toEqual(counter.target_unit_price);
      await call("kiwi_approve", { approval_id: pending.approval_required.approval_id });
      const countered = await call("kiwi_negotiate", { ...counter, approval_id: pending.approval_required.approval_id });
      expect(countered.status).toBe("DONE");
      const counterWire = capture.at(-1)?.payload;
      expect(counterWire?.type).toBe("counter_offer");
      if (counterWire?.type === "counter_offer") {
        expect(counterWire.proposed_terms.items?.[0]?.unit_price).toEqual(counter.target_unit_price);
        expect(counterWire.proposed_terms.price_terms).toBeUndefined();
      }
      const latest = await call("kiwi_compare_quotes", { operation: "refresh", request_id: "refresh-after-counter",
        comparison_id: snapshot.id, expected_revision: refreshed.snapshot.revision, case_ref: { case_id: later.id, revision: later.revision } });
      const renegotiated = latest.snapshot.data.rows.find((row: { price_kind: string }) => row.price_kind === "KNP_OFFER");
      expect(renegotiated.cash_total_minor).toBe(1340880);

      const unsent = { ...counter, request_id: "canceled-counter", expected_offer_digest: renegotiated.offer_digest,
        comparison_ref: { comparison_id: snapshot.id, revision: latest.snapshot.revision } };
      const unsentDraft = await call("kiwi_negotiate", unsent);
      await call("kiwi_approve", { approval_id: unsentDraft.approval_required.approval_id });
      await call("kiwi_prepare_procurement", { operation: "set_state", request_id: "cancel", case_id: later.id,
        expected_revision: later.revision, state: "CANCELLED", reason: "user canceled" });
      expect(await raw("kiwi_negotiate", { ...unsent, approval_id: unsentDraft.approval_required.approval_id })).toMatchObject({ isError: true });
      expect(capture.map(event => event.action)).toEqual(["rfq", "clarification", "rfq", "counter_offer"]);
      const cancelled = await call("kiwi_get_procurement", { operation: "get", case_id: later.id });
      expect(cancelled.case.state).toBe("CANCELLED");
      expect(cancelled.actions.find((action: { request_id: string }) => action.request_id === unsent.request_id).status).toBe("REVOKED");
    } finally {
      store.close();
    }
  });
});
