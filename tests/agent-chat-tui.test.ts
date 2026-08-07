/**
 * Main-chat TUI tests: the readline loop driven with injected in-memory
 * streams — free text, slash commands, /quit, and the EOF-without-/quit
 * path (readline-closed guard).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePathsForDir } from "../src/agent/agent-db.js";
import { runChatTui } from "../src/agent/chat-tui.js";
import {
  ConnectorError,
  type CommerceConnector,
  type ConnectorMerchant,
  type ConnectorProduct,
  type SearchMerchantsQuery,
  type SearchProductsQuery,
} from "../src/agent/connector/types.js";
import { createFakeChatModels } from "../src/agent/fake-chat-model.js";
import { AgentKernel } from "../src/agent/kernel.js";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import { BuyerTaskStore } from "../src/agent/buyer/task-store.js";
import { testBuyerProfile, testProfile } from "./helpers.js";

const PRINCIPAL = "buyer-agent:buyer-001";

/** Connector that always throws a transient error (simulates a down gateway). */
class AlwaysFlakyConnector implements CommerceConnector {
  readonly connector_id = "shopping-cli";
  readonly platform = "shopping-cli";
  async searchProducts(_query: SearchProductsQuery): Promise<ConnectorProduct[]> {
    throw new ConnectorError("transient", "fetch failed");
  }
  async getProduct(_sku: string): Promise<ConnectorProduct> {
    throw new ConnectorError("transient", "fetch failed");
  }
  async searchMerchants(_query: SearchMerchantsQuery): Promise<ConnectorMerchant[]> {
    return [];
  }
  async startConsultation(_input: {
    buyer_id: string;
    sku: string;
    merchant_id: string;
    opening_message: string;
  }): Promise<{ conversation_id: string; status: string }> {
    throw new ConnectorError("auth", "not configured");
  }
}

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

async function setup(): Promise<AgentKernel> {
  const { models, model } = createFakeChatModels();
  return AgentKernel.open({
    profile: testProfile(),
    paths: ensurePathsForDir(path.join(workDir, "agent")),
    models,
    model,
    vault: new PrivateVault(new EnvKeyProvider("a".repeat(64))),
  });
}

describe("runChatTui", () => {
  it("answers free text, runs slash commands, and exits cleanly on /quit", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-chat-"));
    const kernel = await setup();
    const { input, output, text } = streams([
      "记住我更喜欢京东自营",
      "/memory",
      "/why",
      "/quit",
    ]);
    const code = await runChatTui({ kernel, input, output });
    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("Kiwi Merchant · merchant-agent:merchant-001 · 主对话");
    expect(out).toContain("已记住");
    expect(out).toContain("[active] preference/chat.note.");
    expect(out).toContain("正在安全退出");
    expect(kernel.isShutdownRequested).toBe(true);
    await kernel.close();
  });

  it("EOF without /quit exits 0 (no readline-after-close crash)", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-chat-"));
    const kernel = await setup();
    const { input, output } = streams(["你好"]);
    const code = await runChatTui({ kernel, input, output });
    expect(code).toBe(0);
    await kernel.close();
  });

  it("surfaces scheduler search failures in the chat (a down gateway is not silent)", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-chat-"));
    const paths = ensurePathsForDir(path.join(workDir, "agent"));

    // Pre-seed a due buyer task on the same DB the kernel will open, so the
    // startup tick has a search to run (and fail).
    const db = new DatabaseSync(paths.db);
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 2, ?, ?)`,
    ).run(PRINCIPAL, "2026-08-05T12:00:00+08:00", "2026-08-05T12:00:00+08:00");
    const store = new BuyerTaskStore({ db, principalId: PRINCIPAL, now: () => "2026-08-05T12:00:00+08:00" });
    const task = store.createTask({
      goal_text: "买 2 个陶瓷杯",
      intent: { category: "kitchenware", query_text: "陶瓷杯" },
      constraints: {},
      idempotency_key: "seed:1",
    });
    store.transitionTask({
      task_id: task.task_id,
      to: "ready",
      expected_version: task.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: "seed:ready:1",
      next_run_at: "2026-08-05T11:59:00+08:00",
    });
    db.close();

    const { models, model } = createFakeChatModels();
    const kernel = await AgentKernel.open({
      profile: testBuyerProfile(),
      paths,
      models,
      model,
      connector: new AlwaysFlakyConnector(),
      vault: new PrivateVault(new EnvKeyProvider("a".repeat(64))),
    });
    const { input, output, text } = streams(["你好", "/quit"]);
    const code = await runChatTui({ kernel, input, output });
    expect(code).toBe(0);
    const out = text();
    // The startup tick's failed search must reach the chat — a task stuck in
    // tracking with a dead gateway should never look like a no-op.
    expect(out).toContain("[任务]");
    expect(out).toContain("fetch failed");
    expect(out).toContain("已安排自动重试");
    await kernel.close();
  });
});
