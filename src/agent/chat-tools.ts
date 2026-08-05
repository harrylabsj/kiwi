/**
 * Memory tools for the main conversation (design §6.4, §10.1).
 *
 * The MODEL proposes; the STORE disposes. A tool call is only ever a
 * memory candidate/statement — activation, confirmation, Restricted
 * sealing, conflict handling and dedup all happen inside MemoryStore
 * governance. Tools never receive or return Restricted plaintext after a
 * write, and tool results never contain chain-of-thought.
 */

import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { MemoryStore, RememberOutcome } from "./memory/store.js";
import {
  isMemoryNamespace,
  isMemorySensitivity,
  isMemorySourceKind,
  isVaultKind,
  MemoryError,
  parseMemoryScope,
} from "./memory/types.js";
import { VaultKeyError } from "./memory/vault.js";

export const TOOL_REMEMBER = "remember";
export const TOOL_FORGET_MEMORY = "forget_memory";
export const TOOL_CORRECT_MEMORY = "correct_memory";

type Tool = AgentHarnessTool<undefined>;

function textResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function errorText(err: unknown): string {
  if (err instanceof MemoryError) return `记忆操作被拒绝（${err.code}）：${err.message}`;
  if (err instanceof VaultKeyError) return `Vault 不可用：${err.message}`;
  return `记忆操作失败：${err instanceof Error ? err.message : String(err)}`;
}

export function buildMemoryTools(store: MemoryStore): Tool[] {
  const remember: Tool = {
    name: TOOL_REMEMBER,
    label: "记住",
    description:
      "保存一条关于委托人的记忆。用户明确要求记住、或陈述了稳定事实/约束/敏感资料时调用；" +
      "从行为推断时把 explicit_user_statement 设为 false（只会成为候选，不会当成事实）。" +
      "私密值（精确地址、联系方式、私有预算、成本底价）用 restricted_* 字段，绝不要写进 value。",
    parameters: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          enum: ["profile", "constraint", "preference", "routine", "episode", "task_context"],
        },
        key: { type: "string", description: "稳定语义键，如 shopping.promotion.preference" },
        value: { description: "非私密结构化值" },
        restricted_kind: {
          type: "string",
          enum: ["address", "contact", "private_budget", "merchant_cost", "merchant_floor", "other"],
        },
        restricted_value: { type: "string", description: "私密明文，只进加密 Vault" },
        scope: {
          type: "object",
          properties: {
            category: { type: "string" },
            platform: { type: "string" },
            merchant_id: { type: "string" },
            task_id: { type: "string" },
          },
          additionalProperties: false,
        },
        sensitivity: { type: "string", enum: ["normal", "private", "restricted"] },
        source_kind: { type: "string", enum: ["explicit", "observed", "inferred", "imported"] },
        explicit_user_statement: {
          type: "boolean",
          description: "用户亲口陈述（而非模型推断）",
        },
        expires_at: { type: "string", description: "RFC3339；临时上下文才需要" },
        reason_summary: { type: "string", description: "一句可向用户解释的证据摘要" },
      },
      required: ["namespace", "key", "sensitivity", "source_kind", "explicit_user_statement", "reason_summary"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      try {
        const p = params as Record<string, unknown>;
        if (!isMemoryNamespace(p.namespace)) throw new MemoryError("validation", "namespace 非法");
        if (typeof p.key !== "string") throw new MemoryError("validation", "key 非法");
        if (!isMemorySensitivity(p.sensitivity)) {
          throw new MemoryError("validation", "sensitivity 非法");
        }
        if (!isMemorySourceKind(p.source_kind)) {
          throw new MemoryError("validation", "source_kind 非法");
        }
        const restricted =
          p.restricted_value !== undefined || p.restricted_kind !== undefined
            ? {
                kind: isVaultKind(p.restricted_kind) ? p.restricted_kind : ("other" as const),
                plaintext: String(p.restricted_value ?? ""),
              }
            : undefined;
        const outcome: RememberOutcome = store.remember({
          namespace: p.namespace,
          key: p.key,
          ...(restricted === undefined ? { value: p.value ?? null } : { restricted }),
          ...(p.scope !== undefined ? { scope: parseMemoryScope(p.scope) } : {}),
          source_kind: p.source_kind,
          sensitivity: p.sensitivity,
          explicit_user_statement: p.explicit_user_statement === true,
          ...(typeof p.expires_at === "string" ? { expires_at: p.expires_at } : {}),
          evidence: {
            source_type: "chat",
            source_ref: `session:main:${Date.now()}`,
            summary: String(p.reason_summary ?? ""),
          },
          actor: "model",
        });
        if (outcome.kind === "conflict") {
          return textResult(
            `与现有记忆 ${outcome.existing.memory_id}（${outcome.existing.key}）冲突，已记录矛盾证据、未覆盖。` +
              "请向用户确认后再决定。",
          );
        }
        const memory = outcome.memory;
        const note =
          outcome.kind === "active"
            ? `已记住（${memory.memory_id}，置信度 ${memory.confidence}）。`
            : outcome.kind === "merged"
              ? `已有相同记忆，证据已合并（${memory.memory_id}）。`
              : `已存为候选 ${memory.memory_id}，需用户确认后才生效——请告诉用户并询问是否确认。`;
        return textResult(note, { memory_id: memory.memory_id, status: memory.status });
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const forget: Tool = {
    name: TOOL_FORGET_MEMORY,
    label: "遗忘",
    description: "删除一条记忆（用户要求忘掉时调用）。删除是带审计的 tombstone，检索立即失效。",
    parameters: {
      type: "object",
      properties: {
        memory_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["memory_id"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      try {
        const p = params as { memory_id: string; reason?: string };
        const memory = store.forgetMemory(p.memory_id, "user", p.reason ?? "用户要求遗忘");
        return textResult(`已遗忘 ${memory.memory_id}（${memory.key}），不再用于任何回答。`);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const correct: Tool = {
    name: TOOL_CORRECT_MEMORY,
    label: "修正记忆",
    description: "修正一条已有记忆的内容（保留审计）。用户纠正时调用。",
    parameters: {
      type: "object",
      properties: {
        memory_id: { type: "string" },
        value: { description: "修正后的非私密值" },
        reason: { type: "string" },
      },
      required: ["memory_id", "value"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      try {
        const p = params as { memory_id: string; value: unknown; reason?: string };
        const memory = store.correctMemory(
          p.memory_id,
          { value: p.value },
          "user",
          p.reason ?? "用户纠正",
        );
        return textResult(`已修正 ${memory.memory_id}（版本 ${memory.version}），旧值保留在审计事件中。`);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  return [remember, forget, correct];
}
