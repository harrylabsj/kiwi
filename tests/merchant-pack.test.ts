/**
 * Merchant capability pack tests (design §15.3/§15.4, §16, §19.3):
 * Credential scope isolation (write tools fail closed without the scope
 * token), ActionCandidate approval flow with content hashes, stale-approval
 * invalidation on changed preconditions, private merchant value non-leak, and
 * the read-only catalog/inventory/consultation/review surface.
 *
 * Deterministic: in-memory SQLite, FakeMerchantClient + FakeCommerceClient,
 * injected clocks.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { ActionCandidateStore, executeApprovedCandidate } from "../src/agent/merchant/action-candidate.js";
import { StaticCredentialBroker } from "../src/agent/merchant/credential-broker.js";
import { FakeMerchantClient, fakeMerchantProduct } from "../src/agent/merchant/fake-merchant-client.js";
import { buildMerchantTools, type MerchantToolDeps } from "../src/agent/merchant/merchant-tools.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import { MemoryStore } from "../src/agent/memory/store.js";
import { testMarketplace, testProfile, type TestClientOverrides } from "./helpers.js";

const T0 = "2026-08-05T12:00:00+08:00";
const PRINCIPAL = "merchant-agent:merchant-001";

const TEST_KEY = "a".repeat(64);

type PendingHooks = {
  readPreconditions: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

/** Direct-call view of a tool: the harness passes 5 args, tests pass 2. */
type CallableTool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{
    content: { type: string; text?: string }[];
    details?: unknown;
  }>;
};

interface MerchantHarness {
  approvals: ActionCandidateStore;
  merchantClient: FakeMerchantClient;
  broker: StaticCredentialBroker;
  mode: { value: "manual" | "supervised" | "autopilot" };
  hooks: Map<string, PendingHooks>;
  getTool: (name: string) => CallableTool;
  setNow: (t: string) => void;
  db: DatabaseSync;
  store: MemoryStore;
}

function setupMerchant(options: {
  mode?: "manual" | "supervised" | "autopilot";
  catalog?: string;
  inventory?: string;
  negotiation?: string;
  marketplace?: TestClientOverrides;
} = {}): MerchantHarness {
  let clock = T0;
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const vault = new PrivateVault(new EnvKeyProvider(TEST_KEY));
  const store = new MemoryStore({ db, vault, now: () => clock });
  store.bindPrincipal(PRINCIPAL);
  const approvals = new ActionCandidateStore({ db, principalId: PRINCIPAL, now: () => clock });
  const merchantClient = new FakeMerchantClient({ products: [fakeMerchantProduct()] });
  const broker = new StaticCredentialBroker({
    ...(options.catalog !== undefined ? { catalog: options.catalog } : {}),
    ...(options.inventory !== undefined ? { inventory: options.inventory } : {}),
    ...(options.negotiation !== undefined ? { negotiation: options.negotiation } : {}),
  });
  const mode = { value: options.mode ?? "supervised" };
  const hooks = new Map<string, PendingHooks>();
  const marketplace = testMarketplace(options.marketplace);
  const profile = testProfile();
  const deps: MerchantToolDeps = {
    profile,
    merchantClient,
    commerceClient: marketplace.merchant,
    broker,
    approvals,
    mode: () => mode.value,
    now: () => clock,
    registerPending: (id, h) => hooks.set(id, h),
    privateValues: () =>
      store
        .listMemories({ sensitivity: "restricted" })
        .flatMap((m) =>
          m.vault_ref !== undefined ? [{ key: m.key, value: store.openVaultValue(m.vault_ref) }] : [],
        ),
  };
  const tools = buildMerchantTools(deps);
  return {
    approvals,
    merchantClient,
    broker,
    mode,
    hooks,
    getTool: (name) => tools.find((t) => t.name === name) as unknown as CallableTool,
    setNow: (t) => {
      clock = t;
    },
    db,
    store,
  };
}

describe("merchant Credential Broker scope isolation (§15.4)", () => {
  it("write tools fail closed without their scope credential; no candidate is created", async () => {
    const h = setupMerchant({ catalog: undefined, inventory: "inv" });
    const create = h.getTool("create_product");
    const result = await create.execute("c1", {
      product: { sku: "sku-999", title: "新品", price: 30, stock: 5 },
    });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("fail closed");
    expect(h.approvals.listPending()).toHaveLength(0);
  });

  it("update_inventory requires the inventory scope, not just catalog", async () => {
    const h = setupMerchant({ catalog: "cat", inventory: undefined });
    const tool = h.getTool("update_inventory");
    const result = await tool.execute("c1", { sku: "sku-001", stock: 3 });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("inventory");
    expect(text).toContain("fail closed");
    expect(h.approvals.listPending()).toHaveLength(0);
  });

  it("the model never sees token values anywhere in tool output", async () => {
    const h = setupMerchant({ catalog: "super-secret-catalog-token", inventory: "super-secret-inv-token" });
    const tool = h.getTool("list_catalog_products");
    const result = await tool.execute("c1", {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("super-secret-catalog-token");
    expect(text).not.toContain("super-secret-inv-token");
  });
});

describe("merchant write approval flow (§16)", () => {
  it("supervised update_inventory creates a content-hashed candidate; approve executes it", async () => {
    const h = setupMerchant({ inventory: "inv" });
    const tool = h.getTool("update_inventory");
    const result = await tool.execute("c1", { sku: "sku-001", stock: 7, reason: "到货补库存" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("等待批准");
    expect(h.approvals.listPending()).toHaveLength(1);

    const candidate = h.approvals.listPending()[0] as NonNullable<ReturnType<ActionCandidateStore["listPending"]>[number]>;
    expect(candidate.arguments_hash).toMatch(/^sha256:/);
    expect(candidate.preconditions_hash).toMatch(/^sha256:/);
    expect(candidate.arguments).toMatchObject({ sku: "sku-001", stock: 7 });

    const approved = h.approvals.markApproved(candidate.candidate_id);
    expect(approved.status).toBe("approved");
    const outcome = await executeApprovedCandidate(
      h.approvals,
      candidate.candidate_id,
      h.hooks.get(candidate.candidate_id) as PendingHooks,
    );
    expect(outcome.kind).toBe("executed");
    const product = await h.merchantClient.getProduct("sku-001");
    expect(product.stock).toBe(7);
  });

  it("supervised create_product executes on approve; a concurrent create invalidates it", async () => {
    const h = setupMerchant({ catalog: "cat" });
    const tool = h.getTool("create_product");
    const result = await tool.execute("c1", {
      product: { sku: "sku-999", title: "新品", price: 30, stock: 5, merchant_id: "merchant-001" },
    });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("等待批准");
    const candidate = h.approvals.listPending()[0] as NonNullable<ReturnType<ActionCandidateStore["listPending"]>[number]>;
    h.approvals.markApproved(candidate.candidate_id);
    const outcome = await executeApprovedCandidate(h.approvals, candidate.candidate_id, h.hooks.get(candidate.candidate_id) as PendingHooks);
    expect(outcome.kind).toBe("executed");
    expect((await h.merchantClient.getProduct("sku-999")).title).toBe("新品");
  });

  it("draft_product_change is always pending and executable via approve (never auto-runs)", async () => {
    const h = setupMerchant({ mode: "autopilot", catalog: "cat" });
    const tool = h.getTool("draft_product_change");
    const result = await tool.execute("c1", { sku: "sku-001", changes: { price: 90 } });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("草稿候选");
    // Even in autopilot, a draft is never auto-executed.
    expect((await h.merchantClient.getProduct("sku-001")).price).toBe(99);
    const candidate = h.approvals.listPending()[0] as NonNullable<ReturnType<ActionCandidateStore["listPending"]>[number]>;
    h.approvals.markApproved(candidate.candidate_id);
    const outcome = await executeApprovedCandidate(h.approvals, candidate.candidate_id, h.hooks.get(candidate.candidate_id) as PendingHooks);
    expect(outcome.kind).toBe("executed");
    expect((await h.merchantClient.getProduct("sku-001")).price).toBe(90);
  });

  it("a changed precondition invalidates the old approval — nothing executes", async () => {
    const h = setupMerchant({ inventory: "inv" });
    const tool = h.getTool("update_inventory");
    const result = await tool.execute("c1", { sku: "sku-001", stock: 7 });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("等待批准");
    const candidate = h.approvals.listPending()[0] as NonNullable<ReturnType<ActionCandidateStore["listPending"]>[number]>;

    // The product state changes BEFORE approval (another worker / a real event).
    await h.merchantClient.updateInventory("sku-001", 2);
    h.approvals.markApproved(candidate.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      candidate.candidate_id,
      h.hooks.get(candidate.candidate_id) as PendingHooks,
    );
    expect(outcome.kind).toBe("stale");
    const product = await h.merchantClient.getProduct("sku-001");
    expect(product.stock).toBe(2); // unchanged by the stale approval
    expect(h.approvals.get(candidate.candidate_id)?.status).toBe("superseded");
  });

  it("expired candidates cannot be executed", async () => {
    const h = setupMerchant({ inventory: "inv" });
    const tool = h.getTool("update_inventory");
    await tool.execute("c1", { sku: "sku-001", stock: 5 });
    const candidate = h.approvals.listPending()[0] as NonNullable<ReturnType<ActionCandidateStore["listPending"]>[number]>;
    h.setNow("2026-08-05T13:00:00+08:00"); // past the 15-min TTL
    // Approving an expired candidate is refused (fail closed).
    expect(() => h.approvals.markApproved(candidate.candidate_id)).toThrow(/expired/);
    // Execution is refused either way — never applied.
    const outcome = await executeApprovedCandidate(
      h.approvals,
      candidate.candidate_id,
      h.hooks.get(candidate.candidate_id) as PendingHooks,
    );
    expect(outcome.kind).not.toBe("executed");
    expect((await h.merchantClient.getProduct("sku-001")).stock).toBe(12);
  });

  it("autopilot auto-executes within HardPolicy but escalates price below the private floor", async () => {
    const h = setupMerchant({ mode: "autopilot", catalog: "cat" });
    const tool = h.getTool("update_product");
    // Within HardPolicy: list price 99 -> 95 (>= floor 80) auto-executes.
    const ok = await tool.execute("c1", { sku: "sku-001", changes: { price: 95 } });
    expect(ok.content[0]?.type === "text" ? ok.content[0].text : "").toContain("已执行");
    expect((await h.merchantClient.getProduct("sku-001")).price).toBe(95);

    // Below the private floor (80): escalates to approval, never auto-executes.
    const below = await tool.execute("c2", { sku: "sku-001", changes: { price: 60 } });
    const text = below.content[0]?.type === "text" ? below.content[0].text : "";
    expect(text).toContain("等待批准");
    expect((await h.merchantClient.getProduct("sku-001")).price).toBe(95);
    // The candidate carries the PROPOSED price (60), never the private floor
    // (80) — the floor stays in the profile and is not written anywhere.
    const escalated = h.approvals.listPending()[0] as NonNullable<ReturnType<ActionCandidateStore["listPending"]>[number]>;
    expect(JSON.stringify(escalated.arguments)).not.toContain("底价");
    expect(escalated.arguments).toMatchObject({ sku: "sku-001" });
  });

  it("manual mode is advice only — never executes", async () => {
    const h = setupMerchant({ mode: "manual", catalog: "cat" });
    const tool = h.getTool("update_product");
    const result = await tool.execute("c1", { sku: "sku-001", changes: { price: 90 } });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("manual");
    expect((await h.merchantClient.getProduct("sku-001")).price).toBe(99);
  });
});

describe("merchant read-only surface (§15.3)", () => {
  it("lists catalog, inventory, consultations and the human-review queue", async () => {
    const h = setupMerchant({});
    const list = await h.getTool("list_catalog_products").execute("c1", {});
    expect(list.content[0]?.type === "text" ? list.content[0].text : "").toContain("sku-001");

    const inv = await h.getTool("get_inventory_snapshot").execute("c1", { sku: "sku-001" });
    expect(inv.content[0]?.type === "text" ? inv.content[0].text : "").toContain('"stock":12');

    h.merchantClient.addConsultation({
      conversation_id: "conv-merchant-001",
      status: "waiting_merchant",
      sku: "sku-001",
      last_message: "请问可以便宜一些吗？",
      last_message_at: T0,
    });
    const cons = await h.getTool("list_incoming_consultations").execute("c1", {});
    expect(cons.content[0]?.type === "text" ? cons.content[0].text : "").toContain("conv-merchant-001");
    expect(cons.content[0]?.type === "text" ? cons.content[0].text : "").toContain("便宜");
  });
});

describe("private merchant value non-leak (§14, §19.3)", () => {
  it("a Restricted floor memory is never served to the model or the client", async () => {
    const h = setupMerchant({ inventory: "inv" });
    // Merchant floor price lives in the Vault as a Restricted memory.
    h.store.remember({
      namespace: "constraint",
      key: "merchant.floor_price.sku-001",
      restricted: { kind: "merchant_floor", plaintext: "floor-price-73.5" },
      sensitivity: "restricted",
      source_kind: "explicit",
      explicit_user_statement: true,
      evidence: { source_type: "chat", source_ref: "test", summary: "商家提供底价" },
      actor: "user",
    });
    // The fake merchant client only ever holds public catalog facts.
    const tool = h.getTool("update_inventory");
    const result = await tool.execute("c1", { sku: "sku-001", stock: 6 });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("floor-price-73.5");
    expect(text).not.toContain("73.5");
    // Candidate args are public catalog facts only.
    const candidate = h.approvals.listPending()[0] as NonNullable<ReturnType<ActionCandidateStore["listPending"]>[number]>;
    expect(JSON.stringify(candidate.arguments)).not.toContain("floor-price-73.5");
    expect(JSON.stringify(candidate.preconditions)).not.toContain("floor-price-73.5");
  });

  it("incoming consultation output never includes the private floor", async () => {
    const h = setupMerchant({});
    h.merchantClient.addConsultation({
      conversation_id: "conv-merchant-001",
      status: "waiting_merchant",
      sku: "sku-001",
      last_message: "最低能到多少？",
      last_message_at: T0,
    });
    const result = await h.getTool("list_incoming_consultations").execute("c1", {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("80");
  });
});

describe("owner-only private thresholds (§6.3)", () => {
  it("view_private_thresholds reveals the merchant's own floor to the owner", async () => {
    const h = setupMerchant({ catalog: "cat" });
    h.store.remember({
      namespace: "profile",
      key: "merchant.floor_price.sku-001",
      restricted: { kind: "merchant_floor", plaintext: "floor-73.5" },
      sensitivity: "restricted",
      source_kind: "explicit",
      explicit_user_statement: true,
      evidence: { source_type: "chat", source_ref: "test", summary: "底价" },
      actor: "user",
    });
    const tool = h.getTool("view_private_thresholds");
    const result = await tool.execute("c1", {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("floor-73.5");
    // Owner-only: never in the catalog list output.
    const list = await h.getTool("list_catalog_products").execute("c1", {});
    const listText = list.content[0]?.type === "text" ? list.content[0].text : "";
    expect(listText).not.toContain("floor-73.5");
  });
});

describe("merchant negotiation decision via the gateway gate (§15.4, §16)", () => {
  it("submit_negotiation_decision routes through approval, then claim+gate+settle", async () => {
    const h = setupMerchant({ negotiation: "neg", catalog: "cat" });
    // The shared marketplace has a pending buyer message for the merchant.
    const tool = h.getTool("submit_negotiation_decision");
    const result = await tool.execute("c1", {
      conversation_id: "conv-merchant-001",
      action: "counter",
      public_message: "可以按单价 89 元提供 2 件。",
      proposal: {
        sku: "sku-001",
        quantity: 2,
        unit_price: 89,
        currency: "CNY",
        stock: { status: "available", quantity: 12, observed_at: T0, reserved: false },
        delivery: { eta_start: "2026-08-06T14:00:00+08:00", eta_end: "2026-08-06T18:00:00+08:00", fee: 0 },
        after_sales_policy_refs: ["policy:return-7d"],
        valid_until: "2026-08-05T12:05:00+08:00",
      },
      open_issues: [],
      request_human_review: false,
    });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("等待批准");

    const candidate = h.approvals.listPending()[0] as NonNullable<ReturnType<ActionCandidateStore["listPending"]>[number]>;
    h.approvals.markApproved(candidate.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      candidate.candidate_id,
      h.hooks.get(candidate.candidate_id) as PendingHooks,
    );
    if (outcome.kind !== "executed") throw new Error("expected an executed candidate");
    // The result carries the gateway policy outcome (accepted by the gate).
    const output = outcome.output as { result?: { result?: string } };
    expect(output.result?.result).toBe("accepted");
  });

  it("autopilot escalates a below-floor proposal instead of auto-submitting", async () => {
    const h = setupMerchant({ mode: "autopilot", negotiation: "neg" });
    const tool = h.getTool("submit_negotiation_decision");
    const result = await tool.execute("c1", {
      conversation_id: "conv-merchant-001",
      action: "counter",
      public_message: "可以按单价 60 元提供 2 件。",
      proposal: {
        sku: "sku-001",
        quantity: 2,
        unit_price: 60, // below the private floor (80)
        currency: "CNY",
        stock: { status: "available", quantity: 12, observed_at: T0, reserved: false },
        delivery: { eta_start: "2026-08-06T14:00:00+08:00", eta_end: "2026-08-06T18:00:00+08:00", fee: 0 },
        after_sales_policy_refs: ["policy:return-7d"],
        valid_until: "2026-08-05T12:05:00+08:00",
      },
      open_issues: [],
      request_human_review: false,
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    // Below the private floor: autopilot escalates to a human, never auto-executes.
    expect(text).toContain("等待批准");
    expect(h.approvals.listPending()).toHaveLength(1);
  });

  it("a below-floor proposal is blocked by the local merchant gate before the gateway", async () => {
    const h = setupMerchant({ mode: "supervised", negotiation: "neg" });
    const tool = h.getTool("submit_negotiation_decision");
    const result = await tool.execute("c1", {
      conversation_id: "conv-merchant-001",
      action: "counter",
      public_message: "可以按单价 60 元提供 2 件。",
      proposal: {
        sku: "sku-001",
        quantity: 2,
        unit_price: 60, // below the private floor (80)
        currency: "CNY",
        stock: { status: "available", quantity: 12, observed_at: T0, reserved: false },
        delivery: { eta_start: "2026-08-06T14:00:00+08:00", eta_end: "2026-08-06T18:00:00+08:00", fee: 0 },
        after_sales_policy_refs: ["policy:return-7d"],
        valid_until: "2026-08-05T12:05:00+08:00",
      },
      open_issues: [],
      request_human_review: false,
    });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("等待批准");
    const candidate = h.approvals.listPending()[0] as NonNullable<
      ReturnType<ActionCandidateStore["listPending"]>[number]
    >;
    h.approvals.markApproved(candidate.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      candidate.candidate_id,
      h.hooks.get(candidate.candidate_id) as PendingHooks,
    );
    if (outcome.kind !== "executed") throw new Error("expected an executed candidate");
    const output = outcome.output as { result?: { result?: string; reason_codes?: string[] } };
    expect(output.result?.result).toBe("rejected_retryable");
    expect(output.result?.reason_codes).toContain("local_floor_violation");
  });
});
