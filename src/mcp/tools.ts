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
 * 7 个高层 Kiwi Sourcing Tools（战略 v2.5 §6.1，词表单一来源见 KIWI_SOURCING_TOOLS）。
 *
 * 原则：不暴露 KNP 每个底层消息、不复制 UCP 的 Catalog/Checkout tools；宿主 Agent
 * 用少量跨 Merchant 高层工具完成『找供应商 → RFQ → 比较 → 磋商 → Agreement →
 * UCP handoff』编排。每个写工具绑定 idempotency_key 并返回稳定 task_id /
 * candidate_id / approval_id / agreement_id（§6.2）。业务错误经 isError 带内返回，
 * 错误分类（McpError.code）作为跨宿主语义不变量（§6.10）。
 */

import type { McpCallToolResult, KiwiToolDefinition } from "./types.js";
import { McpError } from "../buyer-core/errors.js";
import { KiwiBuyerService } from "../buyer-core/service.js";

function ok(text: string): McpCallToolResult {
  return { content: [{ type: "text", text }] };
}

function err(error: unknown): McpCallToolResult {
  if (error instanceof McpError) {
    return {
      content: [{ type: "text", text: `error ${error.code}: ${error.message}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: `error internal_error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

/** 构造 7 个高层工具。任意 handler 抛出的 McpError 都会被转成 isError 结果。 */
export function buildKiwiTools(service: KiwiBuyerService): KiwiToolDefinition[] {
  const tools: Array<KiwiToolDefinition & { raw?: boolean }> = [
    {
      name: "kiwi_search",
      description:
        "发现候选供应商，并按需跨商家搜索商品。只读。内部语义：Merchant routing + UCP Catalog orchestration + trust/freshness。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1 },
          category: { type: "string" },
          region: { type: "string" },
        },
      },
      async handle(args) {
        try {
          const result = await service.search({
            query: String(args.query),
            category: args.category === undefined ? undefined : String(args.category),
            region: args.region === undefined ? undefined : String(args.region),
          });
          return ok(JSON.stringify({ merchants: result.merchants, note: result.note }));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_request_quotes",
      description:
        "向一个或多个商家发起询价。写操作；必须携带 idempotency_key（可选，缺省自动生成），返回稳定 task_id；KNP RFQ fan-out。CommerceIntent 必须满足冻结契约。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["intent"],
        properties: {
          intent: {
            type: "object",
            additionalProperties: true,
            required: ["intent_id", "intent_type", "items"],
            properties: {
              intent_id: { type: "string", minLength: 1 },
              intent_type: { type: "string", enum: ["purchase", "procurement", "inquiry"] },
              items: { type: "array", minItems: 1 },
            },
          },
          idempotency_key: { type: "string", minLength: 1 },
          merchant_ids: { type: "array", items: { type: "string", minLength: 1 } },
        },
      },
      async handle(args) {
        try {
          const result = await service.requestQuotes({
            intent: (args.intent ?? {}) as Record<string, unknown>,
            idempotency_key: args.idempotency_key === undefined ? undefined : String(args.idempotency_key),
            merchant_ids:
              args.merchant_ids === undefined
                ? undefined
                : (args.merchant_ids as string[]).map(String),
          });
          return ok(JSON.stringify({ task_id: result.task.task_id, task: result.task, created: result.created }));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_get_task",
      description:
        "读取任务状态、报价、部分失败、待审批与过期信息。统一 status/resume 读取面；替代把 offer/pending 状态放在插件内存。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["task_id"],
        properties: { task_id: { type: "string", minLength: 1 } },
      },
      async handle(args) {
        try {
          return ok(JSON.stringify(service.getTask(String(args.task_id))));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_negotiate",
      description:
        "在委托边界内推进磋商。更新同一 task_id；CounterOffer / Clarification；可产生 candidate_id；受 DelegationPolicy max_rounds 等硬约束。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["task_id", "action", "summary"],
        properties: {
          task_id: { type: "string", minLength: 1 },
          action: { type: "string", enum: ["counter_offer", "clarification"] },
          summary: { type: "string", minLength: 1 },
        },
      },
      async handle(args) {
        try {
          const result = await service.negotiate({
            task_id: String(args.task_id),
            action: args.action as "counter_offer" | "clarification",
            summary: String(args.summary),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_accept_agreement",
      description:
        "请求确认并接受非绑定协议。要求有效 approval_id + candidate_id；输出稳定 agreement_id。DelegationPolicy=ask 时若缺审批会返回 approval_required（含持久 approval_id），宿主完成人工审批后携 approval_id 重试。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["task_id", "candidate_id"],
        properties: {
          task_id: { type: "string", minLength: 1 },
          candidate_id: { type: "string", minLength: 1 },
          approval_id: { type: "string", minLength: 1 },
        },
      },
      async handle(args) {
        try {
          const result = await service.acceptAgreement({
            task_id: String(args.task_id),
            candidate_id: String(args.candidate_id),
            approval_id: args.approval_id === undefined ? undefined : String(args.approval_id),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_get_agreement",
      description:
        "读取最终协议、provenance 与审计摘要。只读；Agreement retrieval + digest + audit summary。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["agreement_id"],
        properties: { agreement_id: { type: "string", minLength: 1 } },
      },
      async handle(args) {
        try {
          return ok(JSON.stringify(service.getAgreement(String(args.agreement_id))));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_handoff",
      description:
        "生成交易/PO/联系路径。要求持久 approval；Agreement → UCP Checkout / merchant transaction endpoint。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["agreement_id", "approval_id", "destination_type"],
        properties: {
          agreement_id: { type: "string", minLength: 1 },
          approval_id: { type: "string", minLength: 1 },
          destination_type: { type: "string", minLength: 1 },
          url: { type: "string" },
        },
      },
      async handle(args) {
        try {
          const result = await service.handoff({
            agreement_id: String(args.agreement_id),
            approval_id: String(args.approval_id),
            destination_type: String(args.destination_type),
            url: args.url === undefined ? undefined : String(args.url),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          return err(error);
        }
      },
    },
  ];
  return tools.map(({ raw: _raw, ...t }) => t);
}
