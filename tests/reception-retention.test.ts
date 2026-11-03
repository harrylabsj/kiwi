/**
 * M2：接待留存清理（D10）。
 *  - 会话超过 30 天被清理；
 *  - 用量记录按 merchant@date 的日期部分清理（90 天）；
 *  - 留存作业同时处理两个存储；联系字段 P0a 未收集。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { runReceptionRetention } from "../src/a2a/reception/retention.js";
import { SqliteDailyBudgetStore } from "../src/merchant/ai-runtime/sqlite-budget-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("reception retention", () => {
  it("会话超过保留期后被清理", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-retention-conv-"));
    dirs.push(dir);
    let now = "2026-10-01T00:00:00.000Z";
    const store = new ReceptionConversationStore({
      file: join(dir, "c.json"),
      now: () => now,
      retentionDays: 30,
    });
    store.put("merchant-1", "buyer:1", "ctx_1", { sku: "VQ-001" });
    now = "2026-11-03T00:00:00.000Z";
    expect(store.pruneExpired()).toBe(1);
    expect(store.get("merchant-1", "buyer:1", "ctx_1")).toBeUndefined();
  });

  it("用量按 merchant@date 的日期部分清理", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-retention-budget-"));
    dirs.push(dir);
    const store = new SqliteDailyBudgetStore(join(dir, "budget.sqlite"));
    try {
      store.tryReserveTokens("merchant-1@2026-08-01", "lease-old", 100, 1_000);
      store.tryReserveTokens("merchant-1@2026-11-01", "lease-new", 100, 1_000);
      expect(store.pruneBefore("2026-08-08")).toBe(2);
      expect(store.usedTokens("merchant-1@2026-11-01")).toBe(100);
    } finally {
      store.close();
    }
  });

  it("留存作业同时清理会话与用量，联系字段为 0", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kiwi-retention-job-"));
    dirs.push(dataDir);
    mkdirSync(join(dataDir, "a2a"), { recursive: true });

    let old = "2026-07-01T00:00:00.000Z";
    const conversations = new ReceptionConversationStore({
      file: join(dataDir, "a2a", "reception-conversations.json"),
      now: () => old,
      retentionDays: 30,
    });
    conversations.put("merchant-1", "buyer:1", "ctx_1", { sku: "VQ-001" });

    const budget = new SqliteDailyBudgetStore(
      join(dataDir, "a2a", "reception-budget.sqlite"),
    );
    budget.tryReserveTokens("merchant-1@2026-07-01", "lease-old", 100, 1_000);
    budget.close();

    const result = runReceptionRetention({
      dataDir,
      now: () => "2026-11-03T00:00:00.000Z",
      conversationRetentionDays: 30,
      usageRetentionDays: 90,
    });
    expect(result.conversationsPruned).toBe(1);
    expect(result.budgetRowsPruned).toBeGreaterThan(0);
    expect(result.contactFieldsPruned).toBe(0);
  });
});
