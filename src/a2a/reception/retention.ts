/**
 * 接待留存清理（P0a / D10）。
 *
 * 冻结口径：会话原文与需求 30 天、联系字段 7 天、用量 90 天。
 * P0a 未单独收集联系字段，因此该项为 0；删除作业在 P0b 扩展为
 * 跨副本/墓碑/加密擦除。本作业只清理本实例的两个自有存储：
 *   - `<dataDir>/a2a/reception-conversations.json`（会话/需求）
 *   - `<dataDir>/a2a/reception-budget.sqlite`（日用量与租约）
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { SqliteDailyBudgetStore } from "../../merchant/ai-runtime/sqlite-budget-store.js";
import { RECEPTION_CONFIG_DEFAULTS } from "./config.js";
import { ReceptionConversationStore } from "./conversation-store.js";
import { ReceptionReplyOutbox } from "./reply-outbox.js";

export interface ReceptionRetentionOptions {
  dataDir: string;
  now: () => string;
  conversationRetentionDays?: number;
  usageRetentionDays?: number;
}

export interface ReceptionRetentionResult {
  conversationsPruned: number;
  outboxRecordsPruned: number;
  budgetRowsPruned: number;
  contactFieldsPruned: 0;
}

/** 执行一次留存清理；存储缺失/损坏时尽量完成其余步骤。 */
export function runReceptionRetention(
  options: ReceptionRetentionOptions,
): ReceptionRetentionResult {
  const conversations = new ReceptionConversationStore({
    file: path.join(options.dataDir, "a2a", "reception-conversations.json"),
    now: options.now,
    retentionDays:
      options.conversationRetentionDays ?? RECEPTION_CONFIG_DEFAULTS.retentionDays,
  });
  const conversationsPruned = conversations.pruneExpired();

  // 审查 P2：出站投递记录同步按会话留存期清理；`unknown` 记录保留供对账。
  const retentionDays =
    options.conversationRetentionDays ?? RECEPTION_CONFIG_DEFAULTS.retentionDays;
  const outboxCutoff = new Date(
    Date.parse(options.now()) - retentionDays * 86_400_000,
  ).toISOString();
  const outboxPruned = new ReceptionReplyOutbox({
    file: path.join(options.dataDir, "a2a", "reception-reply-outbox.json"),
    now: options.now,
  }).pruneBefore(outboxCutoff);

  let budgetRowsPruned = 0;
  const budgetFile = path.join(options.dataDir, "a2a", "reception-budget.sqlite");
  if (existsSync(budgetFile)) {
    const usageDays = options.usageRetentionDays ?? RECEPTION_CONFIG_DEFAULTS.usageRetentionDays;
    const cutoff = new Date(
      Date.parse(options.now()) - usageDays * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const budget = new SqliteDailyBudgetStore(budgetFile);
    try {
      budgetRowsPruned = budget.pruneBefore(cutoff);
    } finally {
      budget.close();
    }
  }

  return { conversationsPruned, outboxRecordsPruned: outboxPruned, budgetRowsPruned, contactFieldsPruned: 0 };
}
