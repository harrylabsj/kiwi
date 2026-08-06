/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Deterministic fake chat model for `model.provider: fake` (offline smoke
 * runs and tests — no network, no keys). Rule-based, NOT a real model:
 *
 * - "记住 X"          -> remember tool call (explicit statement), then confirms;
 * - "忘掉/忘记 X"     -> forget_memory tool call when an id is mentioned;
 * - anything else     -> a canned acknowledgment (real models answer freely).
 *
 * Returns a Models collection with the faux provider registered, ready for
 * the AgentHarness.
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Context, Model, MutableModels } from "@earendil-works/pi-ai";
import {
  TOOL_CORRECT_MEMORY,
  TOOL_FORGET_MEMORY,
  TOOL_REMEMBER,
} from "./chat-tools.js";

export const FAKE_CHAT_MODEL_ID = "fake-chat-model";

function lastUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m && m.role === "user") {
      const content = m.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(" ");
        if (text !== "") return text;
      }
    }
  }
  return "";
}

function hasToolResult(context: Context, toolName: string): boolean {
  return context.messages.some((m) => m && m.role === "toolResult" && m.toolName === toolName);
}

function toolResultText(context: Context, toolName: string): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m && m.role === "toolResult" && m.toolName === toolName) {
      const first = m.content[0];
      if (first && first.type === "text") return first.text;
    }
  }
  return "";
}

/** Precise personal data the offline demo must route to the Vault, not plaintext. */
const SENSITIVE_KIND: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "address", pattern: /(住址|地址|住在|家住|收货|寄到).{0,20}\d/ },
  { kind: "contact", pattern: /(电话|手机|微信号|联系方式|邮箱|e-?mail).{0,10}\d{5,}/i },
  { kind: "private_budget", pattern: /(预算|心理价).{0,6}\d/ },
  { kind: "merchant_cost", pattern: /(成本|进价).{0,6}\d/ },
  { kind: "merchant_floor", pattern: /(底价|最低价).{0,6}\d/ },
  { kind: "other", pattern: /(身份证|银行卡|卡号|账号)/ },
];

function classifyNote(note: string): { kind: string } | undefined {
  for (const { kind, pattern } of SENSITIVE_KIND) {
    if (pattern.test(note)) return { kind };
  }
  return undefined;
}

/** One canned behavior step; repeats as a safety net for retries. */
function respond(context: Context) {
  if (hasToolResult(context, TOOL_REMEMBER)) {
    return fauxAssistantMessage(`好的，${toolResultText(context, TOOL_REMEMBER)}`);
  }
  if (hasToolResult(context, TOOL_FORGET_MEMORY)) {
    return fauxAssistantMessage(`好的，${toolResultText(context, TOOL_FORGET_MEMORY)}`);
  }
  if (hasToolResult(context, TOOL_CORRECT_MEMORY)) {
    return fauxAssistantMessage(`好的，${toolResultText(context, TOOL_CORRECT_MEMORY)}`);
  }
  const text = lastUserText(context);
  const rememberMatch = /^记住[:：]?\s*(.+)$/.exec(text.trim());
  if (rememberMatch !== null) {
    const note = (rememberMatch[1] ?? "").trim();
    const sensitive = classifyNote(note);
    return fauxAssistantMessage([
      fauxToolCall(TOOL_REMEMBER, {
        namespace: "preference",
        key: `chat.note.${note.slice(0, 24).replace(/\s+/g, "_")}`,
        source_kind: "explicit",
        explicit_user_statement: true,
        reason_summary: `用户明确要求记住：${note.slice(0, 40)}`,
        // Precise personal data (address/contact/budget/cost/floor) is a
        // Restricted Vault write — never plaintext, and it needs a data key.
        ...(sensitive !== undefined
          ? {
              restricted_kind: sensitive.kind,
              restricted_value: note,
              sensitivity: "restricted",
            }
          : { value: { note }, sensitivity: "normal" }),
      }),
    ]);
  }
  const forgetMatch = /^(?:忘掉|忘记)\s*(mem_[0-9a-z]+)/i.exec(text.trim());
  if (forgetMatch !== null) {
    return fauxAssistantMessage([
      fauxToolCall(TOOL_FORGET_MEMORY, {
        memory_id: (forgetMatch[1] ?? "").toLowerCase(),
        reason: "用户要求遗忘",
      }),
    ]);
  }
  return fauxAssistantMessage(
    `（fake 模型）我听到了：「${text.slice(0, 80)}」。真实模型接入后我会自由回答；` +
      "你可以说「记住 …」，或用 /memory、/forget、/correct、/why。",
  );
}

/** A Models collection whose only model is the deterministic chat fake. */
export function createFakeChatModels(): { models: MutableModels; model: Model<string> } {
  const handle = fauxProvider({ models: [{ id: FAKE_CHAT_MODEL_ID, name: FAKE_CHAT_MODEL_ID }] });
  handle.setResponses([respond, respond, respond, respond]);
  const models = createModels();
  models.setProvider(handle.provider);
  return { models, model: handle.getModel() };
}
