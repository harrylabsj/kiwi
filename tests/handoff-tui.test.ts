/**
 * /handoff TUI 命令集成测试（完成定义 #17：用户能看到 Handoff 目标和已谈妥摘要）。
 *
 * 真机级：真实 AgentKernel（buyer 角色，真实 task store/approvals/handoff
 * 存储）+ runChatTui 注入流驱动——候选预写进 agent dir 的 Ledger，/handoff
 * 从 Ledger 事件投影输出候选生命周期 + 目的地 + display_summary。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePathsForDir } from "../src/agent/agent-db.js";
import { runChatTui } from "../src/agent/chat-tui.js";
import { createFakeChatModels } from "../src/agent/fake-chat-model.js";
import { AgentKernel } from "../src/agent/kernel.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import { FakeCommerceConnector, fakeConnectorProduct } from "../src/agent/connector/fake-connector.js";
import { HandoffEventStore, createHandoffCandidate } from "../src/handoff/index.js";
import { testBuyerProfile } from "./helpers.js";

let workDir: string;

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function streams(lines: string[]): { input: Readable; output: Writable; text: () => string } {
  const input = Readable.from([`${lines.join("\n")}\n`]);
  let buffer = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk);
      callback();
    },
  });
  return { input, output, text: () => buffer };
}

describe("runChatTui /handoff（#17）", () => {
  it("显示候选生命周期 + 目的地 + 商家/摘要（用户可见目标与摘要）", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-handoff-tui-"));
    const paths = ensurePathsForDir(path.join(workDir, "agent"));

    // 预写一个 handoff 候选（created 事件 + 内嵌候选文档）到 agent dir 的 Ledger。
    const ledger = new HandoffEventStore({ dir: path.dirname(paths.db) });
    const candidate = createHandoffCandidate({
      agreement_id: "agr_01JABC",
      negotiation_id: "neg_01JABC",
      agreed_terms: { items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" } }] },
      destination: { type: "external_checkout_url", ref: "https://acme.example/checkout/abc" },
      display_summary: { merchant: "Acme Merchant", summary: "200 units, CNY 835.00/unit" },
      policy_version: "handoff-policy/1",
      expires_at: "2099-12-31T23:59:59Z",
    });
    ledger.appendCandidateEvent({
      kind: "handoff_candidate_created",
      candidate,
      identity: {
        sender_identity: candidate.buyer_identity_ref,
        counterparty_identity: candidate.merchant_identity_ref,
        actor: "buyer",
      },
      capability: { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" },
    });

    const { models, model } = createFakeChatModels();
    const kernel = await AgentKernel.open({
      profile: testBuyerProfile(),
      paths,
      models,
      model,
      vault: new PrivateVault(new EnvKeyProvider("a".repeat(64))),
      connector: new FakeCommerceConnector([fakeConnectorProduct()]),
    });

    const { input, output, text } = streams(["/handoff", "/quit"]);
    const code = await runChatTui({ kernel, input, output });
    expect(code).toBe(0);
    const out = text();
    // #17：用户可见 Handoff 目标与已谈妥摘要
    expect(out).toContain("[handoff] 候选 1 个");
    expect(out).toContain(candidate.handoff_candidate_id);
    expect(out).toContain("PROPOSED");
    expect(out).toContain("external_checkout_url");
    expect(out).toContain("https://acme.example/checkout/abc");
    expect(out).toContain("Acme Merchant");
    expect(out).toContain("200 units, CNY 835.00/unit");
    await kernel.close();
  });
});
