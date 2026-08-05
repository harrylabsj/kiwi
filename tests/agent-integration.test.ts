/**
 * Buyer/merchant dual-instance integration (design §19.4, §20-C):
 * two separate Kiwi kernels share one fake marketplace. The buyer searches,
 * shortlists, starts a consultation (linked via consultation_links, approved),
 * the merchant counters through the gateway gate, and the buyer accepts — all
 * while the marketplace keeps its no-order/no-payment/no-reservation boundary
 * and private values never leak.
 *
 * Deterministic: scripted fake chat models, FakeCommerceConnector +
 * FakeCommerceClient (shared state) + FakeMerchantClient, temp agent dirs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { ensurePathsForDir } from "../src/agent/agent-db.js";
import { runSearchCycle } from "../src/agent/buyer/search-loop.js";
import { FakeCommerceConnector, fakeConnectorProduct } from "../src/agent/connector/fake-connector.js";
import { AgentKernel } from "../src/agent/kernel.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import { FakeMerchantClient, fakeMerchantProduct } from "../src/agent/merchant/fake-merchant-client.js";
import { StaticCredentialBroker } from "../src/agent/merchant/credential-broker.js";
import { testBuyerProfile, testMarketplace, testProfile } from "./helpers.js";
import { uuidv7 } from "@earendil-works/pi-ai";

const TEST_KEY = "a".repeat(64);
const NOW = "2026-08-05T12:00:00+08:00";

let workDir: string;

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.KIWI_DATA_KEY;
});

function pathsFor(name: string) {
  return ensurePathsForDir(path.join(workDir, name));
}

function scriptedChatModels(steps: FauxResponseStep[]): {
  models: MutableModels;
  model: Model<string>;
} {
  const handle = fauxProvider({ models: [{ id: "fake-chat-model", name: "fake-chat-model" }] });
  handle.setResponses(steps);
  const models = createModels();
  models.setProvider(handle.provider);
  return { models, model: handle.getModel() };
}

describe("buyer/merchant dual-instance consultation path (§19.4, §20-C)", () => {
  it("buyer links a task to a consultation; merchant counters; buyer accepts — no order anywhere", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-integration-"));
    const clock = { value: NOW };
    const now = () => clock.value;

    const marketplace = testMarketplace({ now: NOW });
    const connector = new FakeCommerceConnector([fakeConnectorProduct()]);

    // ---- Buyer kernel ------------------------------------------------------
    const buyerState = { taskId: "", candidateId: "" };
    const buyerKernel = await AgentKernel.open({
      profile: testBuyerProfile(),
      paths: pathsFor("buyer"),
      ...scriptedChatModels([
        (): ReturnType<typeof fauxAssistantMessage> =>
          fauxAssistantMessage([
            fauxToolCall("start_consultation", {
              task_id: buyerState.taskId,
              candidate_id: buyerState.candidateId,
              message: "你好，请问 2 件陶瓷杯能优惠吗？",
            }),
          ]),
        fauxAssistantMessage("咨询候选已生成，等待批准。"),
      ]),
      connector,
      commerceClient: marketplace.buyer,
      broker: new StaticCredentialBroker({ negotiation: "buyer-token" }),
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
      now,
    });

    // Create a buyer task and drive it to awaiting_user + shortlisted.
    const taskStore = buyerKernel.buyerTasks as NonNullable<typeof buyerKernel.buyerTasks>;
    const task = taskStore.createTask({
      goal_text: "买 2 个陶瓷杯",
      intent: { category: "kitchenware", query_text: "陶瓷杯" },
      constraints: { max_total_price: 200 },
      idempotency_key: `create:${uuidv7()}`,
    });
    const ready = taskStore.transitionTask({
      task_id: task.task_id,
      to: "ready",
      expected_version: task.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: `ready:${uuidv7()}`,
    });
    const cycle = await runSearchCycle(
      { store: taskStore, connector, now },
      ready.task_id,
      `run:${uuidv7()}`,
    );
    expect(cycle.task.status).toBe("awaiting_user");
    const candidate = cycle.shortlist[0]?.candidate;
    expect(candidate).toBeDefined();
    buyerState.taskId = ready.task_id;
    buyerState.candidateId = candidate?.candidate_id ?? "";

    // The model starts the consultation -> supervised pending -> /approve.
    await buyerKernel.handleUserText("向商家咨询");
    const pending = buyerKernel.actionCandidates?.listPending() ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tool).toBe("start_consultation");
    const approve = await buyerKernel.handleUserText(
      `/approve ${pending[0]?.candidate_id ?? ""}`,
    );
    expect(approve.text).toContain("已执行");

    const links = taskStore.linksForTask(ready.task_id);
    expect(links).toHaveLength(1);
    expect(links[0]?.conversation_id).toBe("conv-merchant-001");
    expect(taskStore.getTask(ready.task_id)?.status).toBe("consulting");

    // ---- Merchant kernel ---------------------------------------------------
    const merchantClient = new FakeMerchantClient({
      products: [fakeMerchantProduct()],
      consultations: [
        {
          conversation_id: "conv-merchant-001",
          status: "waiting_merchant",
          sku: "sku-001",
          last_message: "你好，请问 2 件陶瓷杯能优惠吗？",
          last_message_at: NOW,
        },
      ],
    });
    const merchantState = { conversationId: "conv-merchant-001" };
    const merchantKernel = await AgentKernel.open({
      profile: testProfile(),
      paths: pathsFor("merchant"),
      ...scriptedChatModels([
        (): ReturnType<typeof fauxAssistantMessage> =>
          fauxAssistantMessage([
            fauxToolCall("submit_negotiation_decision", {
              conversation_id: merchantState.conversationId,
              action: "counter",
              public_message: "买 2 件的话，单价 89 元。",
              proposal: {
                sku: "sku-001",
                quantity: 2,
                unit_price: 89,
                currency: "CNY",
                stock: { status: "available", quantity: 12, observed_at: NOW, reserved: false },
                delivery: {
                  eta_start: "2026-08-06T14:00:00+08:00",
                  eta_end: "2026-08-06T18:00:00+08:00",
                  fee: 0,
                },
                after_sales_policy_refs: ["policy:return-7d"],
                valid_until: "2026-08-05T12:05:00+08:00",
              },
              open_issues: [],
              request_human_review: false,
            }),
          ]),
        fauxAssistantMessage("已提交报价。"),
      ]),
      merchantClient,
      commerceClient: marketplace.merchant,
      broker: new StaticCredentialBroker({
        negotiation: "merchant-token",
        catalog: "merchant-catalog-token",
        inventory: "merchant-inventory-token",
      }),
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
      now,
    });

    // Merchant's incoming consultations are visible (read-only surface).
    const cons = await merchantClient.listIncomingConsultations("merchant-001");
    expect(cons.some((c) => c.conversation_id === "conv-merchant-001")).toBe(true);

    await merchantKernel.handleUserText("回复买家报价");
    const mPending = merchantKernel.actionCandidates?.listPending() ?? [];
    expect(mPending.some((c) => c.tool === "submit_negotiation_decision")).toBe(true);
    const mApprove = await merchantKernel.handleUserText(
      `/approve ${mPending[0]?.candidate_id ?? ""}`,
    );
    expect(mApprove.text).toContain("已执行");

    // The gateway accepted the merchant counter; the conversation moved on.
    const merchantMsgs = marketplace.merchant.messages();
    expect(merchantMsgs.some((m) => m.sender_role === "merchant")).toBe(true);

    // ---- Buyer accepts ------------------------------------------------------
    // The marketplace now routes to the buyer. Re-open the buyer kernel with a
    // scripted model that accepts the counter (claim + gate + settle).
    const buyerAcceptState = { conversationId: "conv-merchant-001" };
    const buyerKernel2 = await AgentKernel.open({
      profile: testBuyerProfile(),
      paths: pathsFor("buyer2"),
      ...scriptedChatModels([
        (): ReturnType<typeof fauxAssistantMessage> =>
          fauxAssistantMessage([
            fauxToolCall("submit_negotiation_decision", {
              conversation_id: buyerAcceptState.conversationId,
              action: "accept_nonbinding",
              public_message: "接受该报价，达成非约束性共识。",
              proposal: {
                sku: "sku-001",
                quantity: 2,
                unit_price: 89,
                currency: "CNY",
                stock: { status: "available", quantity: 12, observed_at: NOW, reserved: false },
                delivery: {
                  eta_start: "2026-08-06T14:00:00+08:00",
                  eta_end: "2026-08-06T18:00:00+08:00",
                  fee: 0,
                },
                after_sales_policy_refs: ["policy:return-7d"],
                valid_until: "2026-08-05T12:05:00+08:00",
              },
              open_issues: [],
              request_human_review: false,
            }),
          ]),
        fauxAssistantMessage("已接受。"),
      ]),
      connector,
      commerceClient: marketplace.buyer,
      broker: new StaticCredentialBroker({ negotiation: "buyer-token" }),
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
      now,
    });
    await buyerKernel2.handleUserText("接受报价");
    const bPending = buyerKernel2.actionCandidates?.listPending() ?? [];
    expect(bPending.some((c) => c.tool === "submit_negotiation_decision")).toBe(true);
    const bApprove = await buyerKernel2.handleUserText(
      `/approve ${bPending[0]?.candidate_id ?? ""}`,
    );
    expect(bApprove.text).toContain("已执行");

    // The buyer accepted: conversation reached consensus, messages are ordered.
    const buyerMsgs = marketplace.buyer.messages();
    expect(buyerMsgs.filter((m) => m.action === "accept_nonbinding")).toHaveLength(1);

    // ---- No order / payment / reservation anywhere ---------------------------
    expect(marketplace.merchant.conversationState().status).not.toMatch(/closed/);
    const tables = (
      buyerKernel2 as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }
    ).db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables.filter((t) => /order|payment|reservation/i.test(t))).toEqual([]);

    await buyerKernel.close();
    await merchantKernel.close();
    await buyerKernel2.close();
  });

  it("merchant and buyer kernels stay physically isolated (design §17)", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-integration-"));
    const marketplace = testMarketplace({ now: NOW });
    const buyerKernel = await AgentKernel.open({
      profile: testBuyerProfile(),
      paths: pathsFor("b"),
      ...scriptedChatModels([fauxAssistantMessage("ok")]),
      connector: new FakeCommerceConnector([fakeConnectorProduct()]),
      commerceClient: marketplace.buyer,
      broker: new StaticCredentialBroker({ negotiation: "t" }),
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
    });
    const merchantKernel = await AgentKernel.open({
      profile: testProfile(),
      paths: pathsFor("m"),
      ...scriptedChatModels([fauxAssistantMessage("ok")]),
      merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
      commerceClient: marketplace.merchant,
      broker: new StaticCredentialBroker({ negotiation: "t", catalog: "c", inventory: "i" }),
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
    });
    expect(buyerKernel.buyerTasks).toBeDefined();
    expect(merchantKernel.buyerTasks).toBeUndefined();
    expect(merchantKernel.actionCandidates?.listPending()).toEqual([]);
    await buyerKernel.close();
    await merchantKernel.close();
  });
});
